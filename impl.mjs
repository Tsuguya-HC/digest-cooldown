// Docker image cooldown gate.
//
// Posts a `digest-cooldown` commit status on open PRs that introduce a
// new *external* container-image digest. A PR comment stores the date
// each digest was first observed; once every gated digest has aged
// >= COOLDOWN_DAYS the status flips to success, letting Renovate's
// automerge proceed (requires platformAutomerge=false so Renovate
// honours non-required statuses).
//
// Why: Renovate's minimumReleaseAge can only gate an update when the
// docker datasource exposes a releaseTimestamp. Digests never expose
// one (renovatebot/renovate#38656), so pure digest bumps slip the
// native cooldown. This action supplies it out-of-band, judging purely
// from the PR diff (no PR-body dependency, no head-code execution).
//
// Two gating modes (GATE_VERSION_BUMPS):
//   - false (default, backward compatible): gate only *pure* digest
//     bumps -- the same image:tag whose digest changed. Version bumps
//     (tag changed) and initial pins are left to Renovate's native
//     minimumReleaseAge. Behaviourally identical to the historical
//     action for real diffs; one adversarial edge case (a removed line
//     rendered as `---FROM ...`) is intentionally hardened -- see the
//     default branch below.
//   - true: gate *every newly-introduced* external docker digest --
//     any digest present on the head side of the diff (`+` lines) but
//     absent from the base (any `-` line or unchanged context line).
//     Diff headers are excluded by structural position, not by
//     matching their text: their attacker-controlled paths can
//     superficially resemble a ref but never join base/added (see
//     `hunkContentLines`). Tag-agnostic: version bumps, fresh
//     pins and initial pins are all gated; reformatted/unchanged refs
//     and re-pins to a base digest are not. Because it is pure set
//     membership it cannot be fooled by line multiplicity, cross-file
//     splits or diff-boundary spoofing (unlike a tag-diff heuristic),
//     and it never skips a genuinely new digest. A base digest is
//     trusted because it was itself gated when first introduced -- with
//     two exceptions this trust does not cover, so a skip-listed base ref
//     is excluded from the base-trust set (its digest was never gated,
//     so it must not exempt a same-digest non-skip new ref -- see
//     parseDiff's isSkip guard on base collection), and digests that
//     already existed in the base *before* this mode was enabled are
//     never retroactively gated (a bootstrap exception common to any
//     newly-introduced gate). Use this to make the action the single
//     source of docker cooldown; pair it with disabling native
//     age-gating for docker in Renovate.
//     GATE_AUTHORS scopes which authors get this broad strategy;
//     out-of-scope authors fall back to the pure-digest-bump gate, so
//     narrowing the author scope never fails open -- an out-of-scope
//     author keeps the full default baseline. Note this is *not* the
//     stronger claim "opt-in gates a superset of default": for an
//     in-scope author the two strategies are not ordered by inclusion.
//     Default gates a same-tag digest change even when the new digest is
//     already present elsewhere in the base (a re-pin to a base digest);
//     digest-centric trusts that base digest and does not gate it. So
//     opt-in can gate *less* than default on that one shape. The
//     guarantee is only the fallback one: scoping authors out cannot
//     reduce a PR below the default baseline.
//
// Never gated (both modes): skip-listed registries (first-party,
// signed) and non-docker refs (e.g. GitHub Actions SHA pins, which
// carry a git-commit releaseTimestamp that native gates accurately).
//
// This module is loaded by the action.yml github-script step via
//   require(`${process.env.GITHUB_ACTION_PATH}/impl.mjs`)
// and invoked as `run({ github, context, core })`. github-script v9 runs
// on node24, whose require() can load a top-level-await-free ESM module
// directly, so this ships as ESM (.mjs). It carries no npm dependencies
// -- the authenticated octokit client is injected by the caller. Inputs
// are read from process.env exactly as the historical inline script did,
// keeping output byte-identical.
//
// MUST stay top-level-await-free: node24's require() rejects an ESM
// graph that contains top-level await (ERR_REQUIRE_ASYNC_MODULE). Keep
// all awaits inside run().

const MARKER = '<!-- digest-cooldown -->';
const STATE_RE = /<!-- digest-cooldown-state (\{.*?\}) -->/;
const CONTEXT = 'digest-cooldown';
const TARGET_URL = 'https://github.com/renovatebot/renovate/issues/38656';
// image[:tag]@sha256:<64 hex>
// export される公開面: verify-image-provenance/impl.mjs とそのテストが、同じ ref
// 表記を解析するため本定義を import して再利用している（issue #84）。
// リネーム・挙動変更をするときは、本アクションのテスト（tests/test-digest-cooldown.mjs）
// と verify-image-provenance のテスト（tests/test-verify-image-provenance.mjs）の
// 両方を回すこと。
// `/g` 付きなので `exec` でループすると lastIndex が module 間で共有される状態になる。
// 必ず `matchAll`（内部で clone するので元の lastIndex を汚さない）で使うこと。
//
// 先頭の `(?:<host>:<port>/)?` は `reg.example:5000/team/app:v1` のような
// registry:port 形式のためにある。これが無いと name 部の文字クラスに `:` が無い
// ためホストが脱落し（`5000/team/app:v1` と抽出される）、skip-registries や
// provenance ポリシー表のキーに**永久に一致しない**静かな壊れ方をしていた。
// port は数字のみ・直後にスラッシュが必要なので、`node:20@sha256:...` のような
// tag 付き ref の抽出結果は従来と byte 等価のまま（tag 部は下の `(?::tag)?` が拾う）。
//
// 先頭の `(?:\$\{[^{}]*\}|\})*` は **マッチ開始位置**の穴を塞ぐためにある。name の
// 文字クラスに `$` `{` `}` が無いため、対策前は
//   `+FROM ${MIRROR}ghcr.io/animalife/base@sha256:...`
// から name を `ghcr.io/animalife/base` と抽出していた（`}` の直後からマッチを開始する）。
// 実際に pull されるのは `evil.example.com/ghcr.io/animalife/base@sha256:...` なのに、
// 抽出結果が既定 skip-registries `ghcr.io/animalife` に一致して**冷却ゲートも
// provenance 検証も丸ごと素通り**する fail-open だった（isSkipRef の
// 「素の startsWith による密輸」と同種の穴が、境界一致ではなくマッチ開始位置に
// 残っていた形）。
//
// 直し方として「ref token の左端でなければマッチしない」負 lookbehind を置くのは
// **採らない**。それだと ref 全体がマッチしなくなり digest ごと gated 集合から
// 消えるので、「冷却も掛からない」別の fail-open に化ける。ここでは逆に、展開
// クロージャを name の**先頭に吸収**する。吸収された name は `$` `{` `}` を含むので
// skip prefix にも provenance ポリシー表のキーにも構造的に一致し得ず、
// digest は gated 集合に残ったまま fail-closed になる。
// `${A${B}}` のような入れ子や `${A}${B}` の連結でも、素の登録名に見える左端を
// 作れないよう `}` 単体も吸収対象に含めている。`}` を含まない通常の ref では
// 0 回マッチなので、既存の抽出結果は byte 等価のまま。
// 計算量: 2 つの選択肢は先頭文字（`$` / `}`）で排他、`[^{}]*` は決定的、1 反復が
// 必ず 1 文字以上を消費するので、**指数的**（catastrophic）バックトラックは無い。
// ただし near-miss 行（`}` の長い連続 + `@sha256:` は含むが digest が 64hex に
// 満たない等）では、失敗した各開始位置がクロージャ連続を再走査するため
// **行長に対して二次**になる（実測 Node v24: 4KB 行 19ms / 8KB 71ms / 16KB 317ms /
// 32KB 1.17s / 64KB 4.6s。従来 REF はほぼ 0ms）。
// このアクションは `pull_request_target` で回す前提なので、**diff は PR 作者が
// 制御できる入力**である（write 権限は不要。verify-image-provenance が
// MAX_VERIFY / MAX_REFS を置いているのと同じ前提）。したがって「長い near-miss 行を
// 1 本置いて計算量を焼き切る」ことは外部から可能で、job timeout で kill されれば
// status が未投稿のまま緑で終わる = 自分の PR の gate を消す手段になる。
// そのため上限は下の MAX_SCAN_LINE（走査行長キャップ）で与える。キャップ超過は
// 「判定不能」として throw し、run() の per-PR catch が fail-closed で pending を
// 投稿する。`[^{}]*` に長さ上限を付けて二次を消す案は**採らない** — 上限超の
// `${...}` で吸収が失敗すると、素の登録名に見える左端が復活して skip 密輸の穴が
// 長い変数式で再開通するため。
// （「`@sha256:` を含まない行は matchAll を回さない」事前フィルタは digest を
// 全く含まない行にのみ効き、near-miss には効かない点に注意。だから行長キャップが
// 別に必要になる。）
//
// name 部（展開クロージャを除く）は下の IMAGE_NAME でも「1 行に収まっていない ref」の
// 名前候補を検証するのに使うので、**同じ 1 つのソース**から両方を組み立てる。
// 2 箇所に literal を持つと、片方だけ直した非対称（REF は port を認めるのに
// 名前候補は認めない等）が静かに入り込む。従来の literal と byte 等価。
const REF_NAME_SRC = '(?:[A-Za-z0-9][A-Za-z0-9._-]*:[0-9]+/)?[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?';
export const REF = new RegExp(`((?:\\$\\{[^{}]*\\}|\\})*${REF_NAME_SRC})@(sha256:[0-9a-f]{64})`, 'g');

// 「1 行に収まっていない ref」（下の SPLIT_TAG_KEYS 参照）の名前側フィールドが、
// image name として妥当かを検査する。REF の name 部**そのもの**を全体一致で当てるので、
// 展開クロージャ（`${...}` / `}`）を含む値はここで落ちる = 名前として採用されない。
// REF 側でクロージャを name の先頭に吸収して fail-closed にしている設計（上のコメント）を、
// 分割形式の解決でも崩さないための境界。
const IMAGE_NAME = new RegExp(`^${REF_NAME_SRC}$`);

// REF を走らせる 1 行の長さ上限（バイト = JS の文字数）。上の計算量メモのとおり
// near-miss 行に対する REF は行長の二次なので、`@sha256:` を含む行がこの長さを
// 超えたら判定を諦める（throw）。判定不能を「冷却済み」に縮退させないため、
// 呼び出し側は必ず fail-closed（pending / error）に倒すこと。
// 4096 は実運用の ref 行（Dockerfile / compose / manifest の 1 行）に対して十分広く、
// 二次の実測でも 21ms 程度（Node v24 実測）に収まる点で選んでいる。
//
// export される公開面: verify-image-provenance/impl.mjs が同じ REF を使って diff を
// 走査するため、同一のキャップを import して共有する（片側だけ緩いと、もう片側から
// 同じ diff で計算量を焼ける非対称になる）。
export const MAX_SCAN_LINE = 4096;

// 走査対象行の長さを検査する。超過は「この行は判定不能」であって「gate 対象なし」
// ではないので、静かに continue せず throw する。
export function assertScannableLine(line) {
  if (line.length > MAX_SCAN_LINE) {
    throw new Error(`diff line too long to scan (${line.length} B > ${MAX_SCAN_LINE} B)`);
  }
}

// --- Unknown digest algorithms (home fork) ---------------------------------
//
// REF only understands `@sha256:<64hex>`. A ref pinned with any other OCI
// algorithm therefore matches nothing, never joins the gated set, and — with
// always-report on — is reported as `success: no external image digest bumps
// to gate`. That is a silent fail-open on an input the action simply does not
// understand, which contradicts how it treats every other unjudgeable case.
// Detect such a ref and throw so run()'s per-PR catch falls back to pending.
//
// Hand-rolled rather than a regex on purpose: this runs on *every* content
// line (REF only runs on lines already known to contain `@sha256:`), and a
// regex with `[algo]*:` + a hex run backtracks quadratically on an adversarial
// line. The scan below advances monotonically and never re-reads a character,
// so it stays linear and needs no MAX_SCAN_LINE cap — capping here would turn
// any long unrelated line (a minified asset containing `@`) into a permanent
// pending, which the length cap on REF deliberately avoids by only applying to
// lines that already look like refs.
export const KNOWN_DIGEST_ALGOS = new Set(['sha256']);
// Longest algorithm token considered; OCI's grammar is short and this bounds
// the inner scan regardless of input.
const ALGO_MAX = 32;
// Shortest hex run treated as a digest rather than an incidental `word:hex`
// (md5 is 32 chars; anything shorter is not a content digest).
const DIGEST_HEX_MIN = 32;

const isAlgoChar = (ch) =>
  (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')
  || ch === '+' || ch === '.' || ch === '_' || ch === '-';
const isHexChar = (ch) =>
  (ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f') || (ch >= 'A' && ch <= 'F');

export function assertKnownDigestAlgos(line) {
  for (let at = line.indexOf('@'); at !== -1; at = line.indexOf('@', at + 1)) {
    const algoStart = at + 1;
    let i = algoStart;
    while (i < line.length && i - algoStart < ALGO_MAX && isAlgoChar(line[i])) { i++; }
    if (i === algoStart || line[i] !== ':') { continue; }
    const hexStart = i + 1;
    let j = hexStart;
    while (j < line.length && isHexChar(line[j])) { j++; }
    if (j - hexStart < DIGEST_HEX_MIN) { continue; }
    const algo = line.slice(algoStart, i);
    if (!KNOWN_DIGEST_ALGOS.has(algo.toLowerCase())) {
      throw new Error(`unsupported digest algorithm '${algo}' in the diff; cannot judge the cooldown`);
    }
  }
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Longest image name rendered in the comment table; longer names are
// truncated with an ellipsis. A PR-controlled image ref can be
// arbitrarily long, so cap the *display* to keep the comment bounded
// (part of the comment-DoS hardening, together with the isolated comment
// upsert in run()). Truncation is display-only -- the stored state JSON keys
// on the digest, never the name, so it is unaffected.
const NAME_MAX = 120;

// --- Pure, dependency-injected helpers (exported for direct unit tests,
// like parseDiff/resolveStrategy). run() calls these with COOLDOWN_DAYS /
// TODAY passed in explicitly; the logic is identical to the former
// run()-local closures.

// A stored first-seen date must be a real YYYY-MM-DD. A truthy-but-invalid
// value ("not-a-date") would make ageDays return NaN, and a NaN age is
// dropped by the `d > 0` filter in run() -- silently clearing the cooldown
// (fail-open). Reject anything that is not a genuine ISO calendar date so it
// is re-stamped to TODAY instead of trusted. The final round-trip check
// rejects non-existent calendar days (2026-02-30, 4/31): V8 *normalises*
// those in Date.parse (Feb 30 -> Mar 02) rather than returning NaN, so the
// finite check alone would accept them and then display/age the wrong day.
// The `&&` short-circuits before `new Date(...).toISOString()` on the NaN
// cases (month 13 etc.), so that call never throws on an Invalid Date.
export const isValidDate = (s) =>
  typeof s === 'string'
  && /^\d{4}-\d{2}-\d{2}$/.test(s)
  && Number.isFinite(Date.parse(`${s}T00:00:00Z`))
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

export const ageDays = (iso, today) =>
  Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${iso}T00:00:00Z`)) / MS_PER_DAY);

// --- Instant-precision cooldown (home fork) --------------------------------
//
// The historical state stored a UTC *calendar date* and compared whole days,
// which cuts the advertised cooldown short by up to a day: a digest first seen
// at 23:59Z is stamped with that date and reaches age 1 one minute later, so a
// 3-day gate can clear after 2 days + 1 minute. Running the gate from a JST
// desk widens the gap in the same direction (08:00 JST is the previous UTC
// date). Storing an instant and comparing hours makes "3 days" mean 72 hours.
//
// Old state stays readable: a bare YYYY-MM-DD is interpreted as T00:00:00Z, so
// existing PR comments keep their first-seen and only ever round in the
// conservative (longer) direction. New observations are written as instants.
const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const MS_PER_HOUR = 60 * 60 * 1000;

export const isValidInstant = (s) =>
  isValidDate(s) || (typeof s === 'string' && INSTANT_RE.test(s) && Number.isFinite(Date.parse(s)));

// Parse either representation to epoch ms. Returns NaN for anything else; every
// caller must guard with isValidInstant first (a NaN age would be dropped by
// the `> 0` filter in run() and fail open, the same trap isValidDate closes).
export const toInstantMs = (s) =>
  (isValidDate(s) ? Date.parse(`${s}T00:00:00Z`) : Date.parse(s));

// Hours elapsed between a stored first-seen and `now`. `now` accepts an instant
// or a bare date (tests and the TODAY env override still pass a date).
export const elapsedHours = (seen, now) =>
  (toInstantMs(now) - toInstantMs(seen)) / MS_PER_HOUR;

// Hours still to serve, floored at 0. The status/comment render this back as
// whole days (rounded up) so the wording is unchanged.
export const remainingHours = (seen, now, cooldownDays) =>
  Math.max(0, cooldownDays * 24 - elapsedHours(seen, now));

// Stable key order so the stored state JSON is byte-identical when unchanged.
export const sortedState = (state) => {
  const out = {};
  for (const k of Object.keys(state).sort()) {
    out[k] = state[k];
  }
  return out;
};

// GitHub may round-trip line endings; compare normalised so an unchanged
// render does not churn the comment every run.
//
// export される公開面: verify-image-provenance/impl.mjs も報告コメントの churn 抑止に
// 本関数を import している（issue #84）。リネーム・挙動変更をするときは両アクションの
// テストを回すこと。
export const sameBody = (a, b) =>
  (a || '').replace(/\r\n/g, '\n') === (b || '').replace(/\r\n/g, '\n');

// Render the state comment body. `strategy` (a short label like
// 'pure-bump' / 'digest-centric') is surfaced on the PR itself (#13) so the
// applied gating strategy is visible without reading the Actions log; it is
// display-only and never part of the stored state JSON.
// `bypassLabel` (optional) records that a cooldown-bypass label is attached to
// the PR. When present, a one-line notice is rendered below the table so the
// forced-success status is auditable from the PR itself: the timer keeps
// running (first-seen dates are unchanged) and removing the label resumes the
// cooldown from the original observation. Omitting it leaves the output
// byte-identical to the historical render (the note's array entries are only
// spread in when a label is present), preserving the golden/fuzz equivalence.
// `unresolved`（任意）は「分割形式で書かれていて image 名 = registry を判定できなかった
// digest」の一覧。判定不能は fail-closed 側（外部イメージとして冷却）に倒すが、外部だと
// **判定できた**ケースと表示上まったく同じにしてしまうと、`skip-registries` が効いて
// いないことに誰も気づけない（issue #21）。表の下に 1 行出して区別を残す。空/未指定なら
// 配列展開が 0 件なので、従来の描画と byte 等価。
export const renderComment = (state, names, cooldownDays, today, strategy, bypassLabel,
  unresolved) => {
  const unresolvedList = (unresolved || []).filter((d) => d in state).sort();
  const rows = Object.keys(state).sort().map((dig) => {
    const seenRaw = state[dig];
    // Display the calendar day only; the stored value may now carry a time.
    const seen = typeof seenRaw === 'string' ? seenRaw.slice(0, 10) : seenRaw;
    const left = remainingHours(seenRaw, today, cooldownDays);
    const status = left <= 0 ? '✅ ready' : `⏳ ${Math.ceil(left / 24)}d left`;
    const rawName = names[dig] || '?';
    const name = rawName.length > NAME_MAX ? `${rawName.slice(0, NAME_MAX)}…` : rawName;
    return `| \`${name}\` | \`${dig.slice(0, 19)}…\` | ${seen} | ${status} |`;
  });
  return [
    MARKER,
    `### 🕒 Image digest cooldown (${cooldownDays}d)`,
    '',
    `External image digest bumps wait ${cooldownDays} days before this check passes.`,
    ...(strategy ? [`Gating strategy: **${strategy}**.`] : []),
    '',
    '| image | digest | first seen | status |',
    '|---|---|---|---|',
    rows.join('\n'),
    '',
    ...(unresolvedList.length
      ? [`ℹ️ ${unresolvedList.length} digest(s) above are pinned in a split form (a tag field carrying the digest) whose image name is not in the diff, so \`skip-registries\` could not be applied and they are gated as external: ${unresolvedList.map((d) => `\`${d.slice(0, 19)}…\``).join(', ')}.`, '']
      : []),
    ...(bypassLabel
      ? [`⚠️ Cooldown bypass label \`${bypassLabel}\` is attached: while it stays on this PR, the commit status reports **success** even if digests below are still cooling.`, '']
      : []),
    `<!-- digest-cooldown-state ${JSON.stringify(sortedState(state))} -->`,
  ].join('\n');
};

// image ref を skip 判定・ポリシー表のキーと突き合わせられる形に正規化する。
//   - 先頭の `docker.io/` / `index.docker.io/` / `registry-1.docker.io/` を剥がす
//     （Docker Hub の暗黙レジストリ。`foo/bar` と `docker.io/foo/bar` を同一視する。
//     `index.docker.io` はレガシーな別名、`registry-1.docker.io` は実際の配信ホスト名で、
//     どちらも docker/podman が `docker.io` と同一視する）
//   - tag を落とす。切るのは「最後の `/` より後ろの `:`」だけなので、
//     `reg.example:5000/team/app` のような registry:port を壊さない
// 注意: Docker 公式イメージの `library/` 補完はしない（`php` と `library/php` は別キー）。
//
// export される公開面: verify-image-provenance/impl.mjs が provenance ポリシー表の
// キー正規化と下の isSkipRef のためにこの定義を import する。リネーム・挙動変更をする
// ときは tests/test-digest-cooldown.mjs と tests/test-verify-image-provenance.mjs の
// 両方を回すこと。
export function normalizeImageName(ref) {
  let s = stripRegistryAlias(ref);
  const slash = s.lastIndexOf('/');
  const colon = s.indexOf(':', slash + 1);
  if (colon !== -1) { s = s.slice(0, colon); }
  return s;
}

// Docker Hub の暗黙レジストリ別名だけを剥がす（tag には触らない）。
// skip-registries の **prefix 側**に使う: prefix は registry/name の接頭辞であって
// ref ではないので tag を持たない。prefix にも normalizeImageName（tag 落とし）を
// 掛けていたとき、スラッシュを含まない `reg.example:5000` の `:5000` が tag と誤認
// されて `reg.example` に縮み、**ポートの無い別ホスト** `reg.example/evil/x` まで
// skip する fail-open（= 冷却ゲートに掛からない方向）になっていた。
// module 内部専用（cross-import の公開面ではない）。
function stripRegistryAlias(name) {
  return String(name ?? '').trim().replace(/^(?:index\.|registry-1\.)?docker\.io\//, '');
}

// skip-registries（gate しない registry/name prefix）の一致判定。**セグメント境界**で
// 一致させるのが要点で、素の `startsWith` だと skip prefix `ghcr.io/animalife` が
// `ghcr.io/animalife-evil/x` にも一致してしまう。ghcr.io で似せた org 名を作るのは
// 誰でもできるので、素の startsWith では攻撃者が `ghcr.io/animalife-evil` のイメージを
// 「自社の署名済みイメージ」として冷却ゲートの対象外へ密輸できる（既定の
// skip-registries `ghcr.io/animalife` のままで成立する fail-open）。
// tag 付きの ref（`ghcr.io/animalife/base:1`）や `docker.io/` 前置きでも prefix と
// 一致させるため、正規化後の名前とも突き合わせる。
//
// export される公開面: verify-image-provenance/impl.mjs が同じ判定を import して使う。
// 両アクションの skip-registries が「同一の意味」であることをコードで保証するのが目的で、
// 実装を 2 箇所に持つと片側だけ直した非対称が docs の「同一の意味」を嘘にする
// （実際にそうなっていた: verify 側が境界一致・cooldown 側が素の startsWith）。
// prefix 側も正規化するのが要点。ref だけを正規化していたときは
// 「`foo/bar` という prefix は `docker.io/foo/bar` に一致するのに、`docker.io/foo`
// という prefix は `foo/bar` に一致しない」という非対称があった（fail-closed 方向
// なので実害は「設定したのに効かない」だが、docs が謳う `docker.io/` 正規化の
// 対称性が嘘になる）。
// ⚠️ ただし prefix 側の正規化は **registry 別名剥がしだけ**（stripRegistryAlias）で、
// normalizeImageName の tag 落としは掛けない。prefix は registry/name の接頭辞であって
// ref ではないので tag を持たず、逆に `reg.example:5000` のような port 付きホストの
// `:5000` を tag と誤認して `reg.example` に縮めてしまい、**ポート無しの別ホスト**
// `reg.example/evil/x` まで skip する fail-open になっていた（skip 範囲が広がる =
// gate されなくなる方向。他の正規化はすべて「純粋に追加」で既存の一致を失わないが、
// この 1 ケースだけは範囲を広げる誤りだった）。
export function isSkipRef(name, skipPrefixes) {
  const raw = String(name ?? '');
  const bare = normalizeImageName(raw);
  const boundary = (n, p) => n === p || n.startsWith(`${p}/`);
  return (skipPrefixes || []).some((prefix) => {
    // 末尾スラッシュ付きで書かれても（`ghcr.io/animalife/`）同じ意味に揃える。
    const p = String(prefix ?? '').trim().replace(/\/+$/, '');
    if (!p) { return false; }
    const np = stripRegistryAlias(p);
    return boundary(raw, p) || boundary(bare, p)
      || (np !== p && (boundary(raw, np) || boundary(bare, np)));
  });
}

// Classify unified-diff lines by structural position, shared by both
// gating strategies below. Yields `{ c, line }` only for genuine hunk
// content lines -- context (' '), added ('+') or removed ('-') -- and
// only while positioned inside a hunk. A `diff --git ` line opens a
// file-header area (index/mode/rename/similarity/Binary/`--- `/`+++ `
// and the like) that is skipped entirely until the next `@@ ` hunk
// marker reopens genuine content; before any `diff --git` is seen the
// diff is assumed to already be inside a hunk (covers hand-built/
// partial diffs with no header preamble, as used throughout this
// action's tests). Classifying by position rather than by matching
// header text is what closes both directions of spoofing: a content
// line that merely *renders* like a header (e.g. `+++ ` at the start of
// an added line, because the original content itself started with
// `++ `) is still read as content, and a header line whose
// attacker-controlled path merely *resembles* a ref (e.g.
// `diff --git a/x@sha256:<hex> b/...`) never joins base/added.
//
// export される公開面: verify-image-provenance/impl.mjs とそのテストが、同じ diff
// 分類器で head 側の ref を拾うため本関数を import している（issue #84）。これにより
// メタ行スプーフ耐性（どの行を content と見るか）が両アクションで共通になる。
// リネーム・挙動変更をするときは、本アクションのテスト（tests/test-digest-cooldown.mjs）
// と verify-image-provenance のテスト（tests/test-verify-image-provenance.mjs）の
// 両方を回すこと。
// yield される `hunk` は hunk の通し番号。**連続性の保証**を呼び出し側に渡すために
// ある: unified diff の 1 hunk 内では行が原ファイル上でも連続しているので、2 行の
// 間にある行はすべて diff にも現れる。分割形式 ref の名前解決（resolveSplitNames）は
// この連続性に依存して「間にインデントの浅い行が無い = 同じマッピングブロック」と
// 判定するため、hunk をまたいだ結合を禁じる必要がある。追加フィールドなので、
// `{ c, line }` を分割代入している既存の呼び出し側（verify-image-provenance 含む）は
// そのまま動く。
export function* hunkContentLines(diff) {
  let inHunk = true;
  let hunk = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@ ')) { inHunk = true; hunk++; continue; }
    if (line.startsWith('diff --git ')) { inHunk = false; hunk++; continue; }
    if (!inHunk) { continue; }
    const c = line[0];
    if (c !== ' ' && c !== '+' && c !== '-') { continue; }
    yield { c, line, hunk };
  }
}

// --- 1 行に収まっていない ref（分割形式）の名前解決 -------------------------
//
// REF は「1 行の中の `<name>[:tag]@sha256:<hex>`」しか取れない。ところが設定ファイルには
// ref の構成要素を**複数フィールドに分けて**書く形式があり、digest が載る行に registry が
// 無い。kustomize の `images:` が代表例:
//
//     images:
//       - name: controller
//         newName: registry.infra.tgy.io/tools/taskflow
//         newTag: latest@sha256:<hex>
//
// この `newTag:` 行から REF が抽出する name は **`latest`**（tag であって名前ではない）。
// `skip-registries: registry.infra.tgy.io` を設定していても一致しようがないので、
// 自前レジストリのイメージが外部イメージとして冷却される = **設定に書いた意味が消える**
// （issue #21。fail-closed 方向なので穴ではないが、上流 compromise の発覚待ち時間という
// 本来存在しない前提を、自分でビルドして署名したイメージに課していた）。Helm values の
// `image.repository` / `image.tag` 分割も同じ形。
//
// 解決方針は「digest が載っているフィールドが *tag* を意味するキーだったら、名前は同じ
// マッピングブロックの兄弟キーから採る」。走査単位（REF を回す行）は広げない — 広げると
// MAX_SCAN_LINE の行長キャップと二次バックトラックの前提が引き直しになるため、
// ここは**抽出済みの行に対する別の線形パス**として足す。
//
// 誤結合（別ブロックの名前を拾って skip 側に倒す fail-open）を防ぐ境界は 3 つ:
//   1. hunk をまたがない（上の hunkContentLines の `hunk`）。hunk 内なら行は原ファイル上でも
//      連続なので、ブロックの切れ目（インデントが浅くなる行）は必ず diff に現れる
//   2. インデントが浅くなった時点で深い側の名前を捨てる（親キーが変われば別ブロック）
//   3. リスト項目（`- `）の開始で同じインデントの名前を捨てる（`images:` の項目ごとに独立）
// さらに side（`+` / `-`）ごとに独立に解決する。context 行（' '）は両側に属する。
const SPLIT_TAG_KEYS = new Set(['newtag', 'tag']);
// 名前を供給するキー。kustomize では `newName` が `name`（base 側のマッチ対象名）を
// 置き換える実体、Helm では `repository` が実体で `image` は 1 行形式との併用が多い。
//
// `name` / `image`（旧「weak」キー）は意図的に採用しない。これらは「同じブロックに
// **見えていないだけの** `newName` / `repository` が存在すると、実際に pull される側は
// そちらに上書きされる」立場の値なので、単独で採用すると diff の可視範囲（既定 3 行
// コンテキスト）の外に追い出された `newName` / `repository` に上書きされる名前で
// skip 判定してしまう（攻撃者はコメント行を挟むだけで `newName` を窓の外に出せる）。
// `newName` / `repository` は 1 ブロックにつき高々 1 つで、他のキーに上書きされる
// 立場ではないため単独採用してよい — この非対称が weak キー撤去の根拠。結果として
// `newName` / `repository` の無い `- name: X` だけの kustomize entry は解決不能になる
// （= gate + 判定不能の callout）。これは意図した fail-closed。
const SPLIT_NAME_KEYS = new Set(['newname', 'repository']);

// Bitnami 系 chart 等が使う `registry` + `repository` + `tag` の 3 分割形式の
// 1 つ目のキー。**名前を供給するキーとしては扱わない**: `registry + '/' + repository`
// を合成する案は採らない。chart が実際には `.registry` を読まない（Helm は知らない
// values キーを黙って捨てる）場合、合成した名前は実在しない ref になり、それが
// たまたま skip-registries に一致すると密輸経路になる（実際に pull されるのは
// `repository` 単体が指す docker.io 側）。代わりに「`repository` 単独での解決を
// 無効化するキー」として扱う: 同じブロックに `registry:` があるとき、その
// `repository` 由来の名前は解決不能（unresolved）に倒す（fail-closed のまま
// 「判定不能」として可視化する）。
const SPLIT_REGISTRY_KEY = 'registry';

// `[indent]key: value` を取る。`- ` 付きのリスト項目では、**キーの開始桁**を indent と
// する（`  - name:` と `    newName:` は同じブロックの兄弟なので桁が揃う）。
// 全 content 行に対して回るので線形であることが要件: `^` 固定 + 空白とキー文字が
// 素の文字集合として排他なので、失敗時のバックトラックは行長に対して線形に収まる
// （assertKnownDigestAlgos と同じ理由で、ここに行長キャップは置かない — 無関係な長い行を
// 永久 pending にしてしまうため）。`d` フラグ（hasIndices）は group 4（値）の開始位置を
// `m.indices[4][0]` で取るために付けている。tag スカラーの値レンジ（下の
// resolveSplitNames 参照）を content 行座標で求めるのに使う。
const KEY_LINE = /^([ \t]*)(-[ \t]+)?([A-Za-z0-9][A-Za-z0-9._-]*)[ \t]*:[ \t]*(.*)$/d;

// YAML スカラーの見た目を落とす（引用符・行末コメント）。値の妥当性判定は呼び出し側の
// IMAGE_NAME に任せるので、ここは「囲いを外す」だけに留める。`start` / `end` は
// 「囲いを外した後の値」が `raw`（呼び出し側で言えば KEY_LINE の group 4）の中で
// 占めるオフセット。tag キーの行では、この値レンジと REF マッチの範囲を突き合わせて
// 「スカラー値に完全に収まるマッチだけ差し替える」境界に使う（A。詳しくは
// resolveSplitNames と parseDiff の blockNameFor を参照）。
const scalarValue = (raw) => {
  const v = raw.trim();
  const q = v[0];
  if (q === '"' || q === "'") {
    const end = v.indexOf(q, 1);
    const value = end === -1 ? v.slice(1) : v.slice(1, end);
    return { value, start: 1, end: 1 + value.length };
  }
  const comment = v.indexOf(' #');
  const value = (comment === -1 ? v : v.slice(0, comment)).trim();
  return { value, start: 0, end: value.length };
};

// content 行の配列に対し、同じ添字で「その行が tag キーなら、同じブロックが供給する
// image 名（無ければ null）と、tag スカラー自身の値レンジ（content 行座標、A）」を
// `{ name, start, end }` で返す。tag キーでない行は undefined。前方 / 後方の 2 パス
// （× side 2 通り）をいずれも線形で回すので、全体で O(行数)。
//
// 名前を供給するのは SPLIT_NAME_KEYS（`newName` / `repository`）だけ（B）。
//
// 1 ブロックにつき候補は**集合**として集める（`names` / `nameKeys`）。「1 ブロック
// 1 名前」という前提は攻撃者制御の diff では成り立たない: `newName` は kustomize
// が、`repository` は Helm が読むキーで、**読む道具が違う**。両方を同じブロックに
// 書けば、片方は実際に pull されず、もう片方だけを実行系が読む状況を diff の
// 見た目だけで作れる（例: values.yaml に本物の `repository:` を残したまま
// `newName:`（kustomize 専用、Helm は黙って捨てる）を 1 行足すだけで、そちらが
// 「実効名」として採用されてしまう）。distinct な候補が 2 つ以上あるときは、diff
// を読むだけではどちらが実際の実効名か決められないので**解決しない**（曖昧さは
// fail-closed。`name: null` = unresolved → gate + callout。詳細は下の最終マージ）。
//
// registry キーの扱い（C）: `repository` 由来の名前は、同じブロックに `registry:`
// があれば無条件で unresolved（`name: null`）に倒す。判定は `hasRegistry &&
// nameKeys.has('repository')` — 「採用された名前が repository 由来か」ではなく
// 「repository というキーがこのブロックの候補に含まれているか」で見るのが要点
// （candidate が 2 つ以上あるケースと合わせて同じ穴を閉じる）。
// ここは **各パスの内側で invalidated を確定させてから OR してはいけない**（一度
// そう書いて fail-open になった実装ミスの記録）。前方パスは「`registry:` が tag
// より前」にあるときしか観測できず、後方パスは「`registry:` が tag より後ろ」に
// あるときしか観測できないので、`repository:` と `registry:` が tag 行を挟んで
// 反対側にあると、forward / backward のどちらの `here()` も「name と hasRegistry
// が両方そろった状態」には決して至らない。同じ理由で `names` / `nameKeys` も
// 前方パスと後方パスの**和集合**でなければならない: `newName` と `repository` が
// tag 行を挟んで反対側にあると、片方向のパスだけでは候補が半分しか集まらず、
// 曖昧さそのものを取りこぼす。肯定条件（候補が見つかった）も否定条件（「このブロック
// に registry: が"ある"」）も、両方向の観測を先にマージしてから判定しなければ
// ならない（B で塞いだ「見えていない strong に上書きされる」と同じ穴の別形）。
// そのため各パスは「観測した候補名の集合・供給キーの集合・registry: が見えたか」を
// 生の事実として記録するだけに留め（下の record）、name / invalidated の判定は
// 最終マージ（下の return）で 1 回だけ行う。
//
// module 内部専用（cross-import の公開面ではない）。verify-image-provenance も同じ
// skip-registries を同じ意味で持つ以上、いずれ同じ解決が要るはずだが、そのときは
// この関数ごと共有する（判定を 2 実装持つと、片側だけ直した非対称が
// isSkipRef で一度起きたのと同じ形で戻ってくる）。姉妹アクション側は現時点では
// 分割形式 ref を一切解決しない非対称が既知で残っている（action.yml 参照）。
function resolveSplitNames(content) {
  const before = new Array(content.length);
  const after = new Array(content.length);
  const isTagLine = new Array(content.length).fill(false);

  for (const side of ['+', '-']) {
    for (const forward of [true, false]) {
      const out = forward ? before : after;
      // インデントは入れ子なのでスタック規律に従う（末尾ほど深い）。Map + 全キー
      // 走査でも同じ結果になるが、それだと 1 行あたり O(保持段数) 掛かる（行長を
      // 深さに使える PR 作者制御の入力なので、全体では入力サイズに比例して伸びる）。
      // pop で閉じれば償却 O(1) で、行ごとの割り当ても要らない。
      const levels = [];
      const top = () => (levels.length ? levels[levels.length - 1] : null);
      let hunk = null;
      const n = content.length;
      for (let step = 0; step < n; step++) {
        const i = forward ? step : n - 1 - step;
        const { c, line, hunk: h } = content[i];
        if (c !== side && c !== ' ') { continue; }
        // context 行（' '）は両側のパスを通る（どちらの側の名前も供給しうる）が、
        // **記録するのは base 側のパスだけ**にする。同じ添字を 2 回書くと結果が
        // パスの実行順に依存してしまうため。context 行に載った ref は base 側の
        // ref としてしか使われない（digest-centric では base、pure-bump では無視）
        // ので、base 側の解決結果が採るべき答えになる。
        const recordHere = (c === ' ' ? '-' : c) === side;
        if (h !== hunk) { levels.length = 0; hunk = h; }
        // CRLF 対応: JS の `.`（KEY_LINE の group 4）は行末終端文字（`\r` 含む）を
        // 除外するのに、`$` は入力の絶対末尾にしかマッチしない（`/m` 無し）。CRLF
        // 改行のリポでは行末に `\r` が残ったまま KEY_LINE に渡ると `.*` が `\r` の
        // 手前で止まり `$` と噛み合わず**マッチそのものが失敗し**、この行が
        // `key: value` として一切認識されない（skip-registries が丸ごと no-op に
        // なり、callout も出ない黙った壊れ方 — issue #21 の症状そのまま）。ここで
        // 落とすのは末尾の 1 文字だけなので、下のオフセット計算（`m.indices[4][0]`
        // 基準）は崩れない。`hunkContentLines` 自体は姉妹アクションとの共有面
        // なのでそちらは触らない。
        const body = line.slice(1);
        const clean = body.endsWith('\r') ? body.slice(0, -1) : body;
        const m = KEY_LINE.exec(clean);
        if (!m) { continue; }
        const indent = m[1].length + (m[2] ? m[2].length : 0);
        const key = m[3].toLowerCase();
        const item = Boolean(m[2]);
        // 深いブロックは閉じた。前方でも後方でも「インデントが浅い行を挟んだら別ブロック」。
        while (levels.length && top().indent > indent) { levels.pop(); }
        // リスト項目の開始は、同じインデントに積まれた候補（隣の項目のもの）を閉じる。
        const closeItem = () => { if (item && top() && top().indent === indent) { levels.pop(); } };
        const here = () => (top() && top().indent === indent ? top() : null);
        const openLevel = () => {
          let lv = here();
          if (!lv) { levels.push(lv = { indent, names: new Set(), nameKeys: new Set() }); }
          return lv;
        };
        const applyOwn = () => {
          if (key === SPLIT_REGISTRY_KEY) {
            openLevel().hasRegistry = true;
            return;
          }
          if (!SPLIT_NAME_KEYS.has(key)) { return; }
          const value = scalarValue(m[4]).value;
          if (!IMAGE_NAME.test(value)) { return; }
          const lv = openLevel();
          lv.names.add(value);
          lv.nameKeys.add(key);
        };
        const record = () => {
          if (!SPLIT_TAG_KEYS.has(key) || !recordHere) { return; }
          isTagLine[i] = true;
          const sv = scalarValue(m[4]);
          // +1: KEY_LINE は line.slice(1)（CRLF なら末尾の `\r` も落とした clean）に
          // 対して exec しているので、content 行（先頭の +/-/ を含む）座標に揃える
          // には group 4 の開始位置に 1 を足す。`\r` を落としたのは末尾だけなので、
          // 先頭からの相対位置（= このオフセット計算）には影響しない。
          const base = 1 + m.indices[4][0];
          const lv = here();
          // ここでは name / invalidated を確定させない（上のコメント参照）。この
          // 方向から観測できた生の事実（候補名の集合・供給キーの集合・registry:
          // が見えたか）だけを積む。集合は同じ添字を 2 回書き換えないよう、この
          // 時点でのスナップショット（コピー）を取る — `lv` はこの後も同じパス内で
          // 変異し続けるので、参照のまま持つと未来の行の追加が過去の記録を
          // 書き換えてしまう。
          out[i] = {
            names: lv ? new Set(lv.names) : new Set(),
            nameKeys: lv ? new Set(lv.nameKeys) : new Set(),
            hasRegistry: Boolean(lv && lv.hasRegistry),
            start: base + sv.start,
            end: base + sv.end,
          };
        };
        if (forward) {
          // 前方: リスト項目の開始で、直前の項目が置いた候補を捨ててから自分を積む。
          closeItem();
          applyOwn();
          record();
        } else {
          // 後方: いま持っている状態は「この行より後ろ」の候補。自分を積んで記録し、
          // 自分がリスト項目の開始なら、ここより前の行は別項目なので捨てる。
          applyOwn();
          record();
          closeItem();
        }
      }
    }
  }
  return content.map((_, i) => {
    if (!isTagLine[i]) { return undefined; }
    const b = before[i];
    const a = after[i];
    // 候補名 / 供給キー / registry の有無は、いずれも前方・後方の**和集合**で決める
    // （上のコメント参照）。片方向だけでは「見えていないだけ」を「無い」/「1 つだけ」
    // と誤読する fail-open になる。
    const names = new Set([...(b?.names ?? []), ...(a?.names ?? [])]);
    const nameKeys = new Set([...(b?.nameKeys ?? []), ...(a?.nameKeys ?? [])]);
    const hasRegistry = Boolean(b?.hasRegistry || a?.hasRegistry);
    const invalidated = hasRegistry && nameKeys.has('repository');
    // distinct な候補がちょうど 1 つのときだけ解決する。0 個（候補なし）も 2 個
    // 以上（曖昧）も同じ `null`（unresolved）に倒す — 呼び出し側は元々この 2 つを
    // 区別していない。
    const name = invalidated || names.size !== 1 ? null : [...names][0];
    return {
      name,
      start: (b ?? a).start,
      end: (b ?? a).end,
    };
  });
}

// 1 本の REF マッチに対して、gate / skip 判定に使う実効的な image 名を決める。
// 差し替えるのは「tag を意味するキーの値から抽出された、registry を持ちようのない名前」
// だけ: `/` を含む時点でそれは（少なくとも構文上は）完全な名前なので、行の書式に
// 関わらずそのまま扱う。`${...}` 吸収済みの名前は IMAGE_NAME に一致しないので
// 差し替え対象から外れ、skip 密輸の穴を塞いだ設計（REF のコメント）が保たれる。
// 解決できなかった分割形式は raw のまま返し、`unresolved: true` を立てて呼び出し側に
// 「registry を判定できなかった」ことを伝える（黙って外部イメージ扱いにしない）。
// 呼び出し元（parseDiff の blockNameFor）は、tag スカラーの値と完全一致する REF
// マッチにだけ解決結果（`blockName`）を渡す（A）。マッチしないケースは `blockName`
// が undefined のまま届き、この関数は raw を素通しする。
// 返り値の `name` は gate / skip の**信頼判定**にのみ使う。pure-bump の「同じ tag か」
// という**同一性判定**（bump の key）にはこの解決名を混ぜない — 解決状態（diff の
// 見え方次第で変わりうる）を同一性の判定に使うと、名前行の有無だけで bump の
// key が割れて gate が消える別の穴になる（Round 2、下の parseDiff 参照）。
function effectiveRefName(raw, blockName) {
  if (blockName === undefined) { return { name: raw, unresolved: false }; }
  if (raw.includes('/') || !IMAGE_NAME.test(raw)) { return { name: raw, unresolved: false }; }
  if (blockName === null) { return { name: raw, unresolved: true }; }
  return { name: blockName, unresolved: false };
}

// Return `{ gated, unresolved }` for a diff. `gated` maps digest -> imageRef,
// the external docker digests a diff should gate (the shape this function
// used to return bare). `unresolved` maps digest -> token for the *gated*
// digests whose split-form image name could not be resolved (F: this used to
// be a 4th `onUnresolvedName(digest, token)` callback; folded into the return
// value instead because this codebase has no other precedent for reporting
// output via an injected side-effect callback -- `isSkip` below is the
// opposite shape, an *input* injection, not an output channel). `digestCentric`
// selects the strategy (see the header comment): the caller enables it only
// for in-scope PR authors, so a non-scope author still gets the default
// pure-digest-bump baseline. `isSkip(name)` tells whether an image ref is on
// the skip list; it is injected so this function stays pure and directly
// unit-testable.
export function parseDiff(diff, digestCentric, isSkip) {
  const gated = {};
  const unresolved = {};
  // 分割形式の名前解決は行をまたぐので、走査の前に content 行を 1 度だけ配列化する
  // （hunkContentLines 自体は generator のまま = 他アクションとの共有面は不変）。
  const content = [...hunkContentLines(diff)];
  const blockNames = resolveSplitNames(content);
  // REF の 1 マッチが、そのマッチが載っている行の tag スカラーの値と**完全一致**
  // するときだけ、そのマッチを分割形式の解決対象にする（A、Round 2 で内包判定から
  // 完全一致に強化）。tag フィールドの値が丸ごと 1 本の ref そのものであることだけが、
  // その値を「この ref の tag 部分」と読んでよい唯一の根拠 — 値の中に余剰トークンが
  // 1 文字でもあれば、値の意味は確定しない（どのトークンが「本当の tag」なのか
  // ref token の文法だけでは決められない）。内包判定（マッチが値レンジに収まっていれば
  // 良い）は、YAML の plain scalar として正当な形（タブ + `#`、カンマ区切り、
  // スペース区切り、引用符内の 2 本目）で余剰トークンを足すだけで、2 本目の ref も
  // 兄弟ブロックの信頼名に丸ごと吸収させてしまう fail-open だった（Round 1 の A の
  // 穴がスカラー内部に移動しただけ）。完全一致なら、余剰トークンがある時点で
  // 値全体のレンジがどのマッチの範囲とも一致しなくなるので、全マッチが raw のまま
  // 通常の ref として扱われ、値の解釈が確定しない限り解決しない（fail-closed）。
  // マッチしないケースは素通し — 差し替えると、たまたま同じ行に載っただけの
  // 無関係な ref まで信頼レジストリ名に化けて gate を素通りする fail-open になる。
  //
  // 「tag 行ではない」（`b` が無い）と「tag 行だがスカラーとスパンが一致しなかった」
  // は区別して返す: 前者は `undefined`（effectiveRefName は raw をただの通常 ref
  // として素通しする — unresolved フラグも立てない）、後者は `null`（`b` はあるが
  // このマッチはその値レンジと一致しない = 分割形式の tag 行なのに解決できなかった
  // という判定不能）。この 2 つを undefined 1 つに潰すと、Round 2 の完全一致化で
  // 解決から外れたケース（YAML として正当な行末コメントがたまたま `#` の直前に
  // スペースを置いていない等）が、判定不能の可視化を経ずに黙って「通常の ref」
  // として gate されてしまう（callout が出ない silent な抜け穴 — Round 3 実測）。
  // effectiveRefName は既に `blockName === null` を unresolved 扱いにしているので、
  // ここを直すだけで済む。
  // ⚠️ digest-centric ではこの区別は**可視化のみ**（`gated` は不変、`unresolved` の
  // 表示だけが変わる）だが、**pure-bump ではそうではない**: `unresolved` フラグは
  // 下の pure-bump 節の `sameImage`（item 4 の初回 pin 免除の精密化）の
  // `anyUnresolved` に流れ込み、**gate されるかどうかの判定そのものの入力**になる。
  // ここを `undefined` に戻すと、判定不能な tag 行が「解決済みだが base と名前が
  // 重ならない別イメージ」と誤断されて `sameImage` が偽になり、本来 fail-closed で
  // gate されるべき同一 tag の digest bump が非 gate に落ちる（`sameImage` 側の
  // コメントにも同じ結合を記している — 片方だけ読んだ保守者が気づけるように）。
  const blockNameFor = (i, m) => {
    const b = blockNames[i];
    if (!b) { return undefined; }
    if (m.index !== b.start || m.index + m[0].length !== b.end) { return null; }
    return b.name;
  };
  // 3 箇所（下の digest-centric added / digest-centric base / pure-bump）で
  // 同じ `effectiveRefName(m[1], blockNameFor(i, m))` を呼んでいたのを 1 つに畳む
  // （このファイルが繰り返し踏んできた「片側だけ直した非対称」の再発地点を減らす）。
  const resolve = (i, m) => effectiveRefName(m[1], blockNameFor(i, m));
  if (digestCentric) {
    // Digest-centric: gate every external docker digest newly
    // introduced by the PR -- present on a `+` content line but absent
    // from the base (any `-` line or unchanged context line).
    // Tag-agnostic set membership: version bumps, fresh pins and
    // initial pins are all gated; reformats and re-pins to a base
    // digest are not. Immune to line multiplicity, cross-file splits
    // and diff-boundary/metadata spoofing, and never skips a new digest.
    const baseDigests = new Set();
    const added = [];
    for (let i = 0; i < content.length; i++) {
      const { c, line } = content[i];
      // A ref always contains the literal `@sha256:`; a line without it can
      // carry no digest, so skip it before running matchAll. This also caps
      // REF's cost on long non-ref lines (a ReDoS prefilter) -- matchAll is
      // never spun over a line that cannot match.
      assertKnownDigestAlgos(line);
      if (!line.includes('@sha256:')) { continue; }
      assertScannableLine(line);
      if (c === '+') {
        for (const m of line.matchAll(REF)) {
          const { name, unresolved: unres } = resolve(i, m);
          added.push({ name, digest: m[2], unresolved: unres });
        }
      } else {
        // Only skip-*non*-listed base refs seed the base-trust set. A
        // skip-listed image is never gated, so its digest was never cooled
        // when introduced; letting it into baseDigests would exempt a
        // same-digest *non*-skip new ref that legitimately needs gating
        // (symmetry with the isSkip guard applied to added refs below).
        for (const m of line.matchAll(REF)) {
          const { name } = resolve(i, m);
          if (!isSkip(name)) baseDigests.add(m[2]);
        }
      }
    }
    // gated[digest] と unresolved[digest] は必ず**同じ added エントリ**から決める
    // （E）。同一 digest が複数の added エントリを経由するとき gated[] は最後の
    // エントリの後勝ちで決まる — unresolved の可視化もその同じ後勝ちエントリに
    // 揃えないと、PR コメントの表と footer の注記が自己撞着する（解決済みの名前が
    // 出ているのに「判定不能」と言う、またはその逆）。
    for (const { name, digest, unresolved: unres } of added) {
      if (isSkip(name) || baseDigests.has(digest)) { continue; }
      gated[digest] = name;
      if (unres) { unresolved[digest] = name; } else { delete unresolved[digest]; }
    }
    return { gated, unresolved };
  }
  // Default: gate a pure digest bump -- the same image:tag now carries
  // a different digest. Behaviourally identical to the historical
  // implementation for the *normal* real diff (each image:tag has a
  // single digest per side); context lines (' ') are still ignored,
  // matching the historical behaviour of not using context as a tag
  // source. Sharing `hunkContentLines` with the digest-centric strategy
  // closes the same class of header-text-matching spoof here (e.g. a
  // removed content line rendered as `---FROM ...`, which a literal
  // `line.slice(0, 3) === '---'` prefix check used to mistake for a file
  // header).
  //
  // key -> Set<digest> (not a last-wins scalar): the same image:tag can
  // legitimately appear more than once per side (a real bump plus a
  // reformatted duplicate of the old ref), and an attacker can re-list the
  // old digest last on the `+` side. A scalar last-occurrence-wins map
  // dropped the earlier digest, so `-app:1@D1 / +app:1@D2 / +app:1@D1`
  // collapsed newByTag[app:1] to D1 == old and gated nothing (fail-open,
  // #11). Keeping every digest in a Set preserves multiplicity: any new
  // digest under an existing tag is gated even when the old digest is also
  // present. For the single-digest normal case the result is byte-identical
  // to the historical map.
  //
  // 素の `{}` ではなく **Map** を使うのが要点。image 名は PR の diff から来る
  // 攻撃者制御の文字列で、REF の name 部 `[A-Za-z0-9][A-Za-z0-9._/-]*` は
  // `constructor` / `toString` / `valueOf` / `hasOwnProperty` をそのまま許す。
  // オブジェクトだと `target['constructor']` が継承した `Object` を返して nullish に
  // ならないため `(target[m[1]] ??= new Set()).add(...)` が代入をスキップし、
  // `.add is not a function` で throw していた（tag 無しの `FROM constructor@sha256:...`
  // で成立）。その例外は run() の per-PR catch に入るので、**投稿すべき status が
  // 投稿されないまま step が緑で終わる** fail-open になっていた（現在は catch 側も
  // fail-closed で pending を投げるようにしたが、二重に閉じておく）。
  // Map はキー空間がプロトタイプと交わらないので構造的に起こり得ない。
  //
  // key は**必ず raw tag トークン（`m[1]`）そのもの** — 分割形式で解決できた名前を
  // 混ぜない（Round 2 で D を差し替え）。以前は解決名だけだと tag 情報が失われる
  // ことを理由に `${解決名}:${raw}` の合成キーを使っていたが、それだと「名前行の
  // 有無」という diff の見え方だけで同じ bump のキーが割れてしまう: 名前行を削除・
  // 変更・追加するだけで base 側と head 側のキーが一致しなくなり、`olds` が
  // undefined になって同一 tag の digest bump が丸ごと非 gate に落ちる（しかも
  // head 側は unresolved のまま gate に到達しないので unresolved にも載らない —
  // 「判定不能は fail-closed + 可視化」の原則が既定モードで崩れていた）。
  // bump の**同一性判定**（このキー）は解決状態から独立させ、raw tag トークンだけで
  // 決める（main と同じ土俵。1 行形式の ref はもともと raw トークンが `<name>:<tag>`
  // を丸ごと含むので、この変更でも挙動は変わらない）。**信頼判定**（skip）は下の
  // `pairNames` で別軸として持つ。
  const oldByTag = new Map();  // key(raw tag token) -> Set<digest>
  const newByTag = new Map();  // key(raw tag token) -> Set<digest>
  // (key, digest) ペアごとに、`+` 側で観測した実効名（解決名 or raw のフォール
  // バック）の集合と、最後の出現の {name, unresolved} を覚えておく。
  //
  // skip 判定は「そのペアに紐づく実効名が**全部** skip 一致のときだけ skip」— 1 つ
  // でも非 skip があれば gate する。raw tag トークンは registry を持たないので
  // （同じ `latest` を指す 2 つの無関係なブロックが同じキーを共有しうる）、片方の
  // ブロックが信頼レジストリを指し、もう片方が信頼できないレジストリを指す状況が
  // 起こりうる。ここで「1 つでも skip なら skip」（= some）にすると、信頼できる
  // ブロックの存在が信頼できないブロックの digest まで skip 免除してしまう
  // fail-open になる。「全部 skip のときだけ skip」なら、そのケースでも非 skip 側の
  // digest は正しく gate される。
  //
  // 表示名 / unresolved は E の原則どおり最後の出現から採る**が、集合（信頼判定）と
  // 代表値（表示）で採用条件が違う**: 集合には全出現を無条件に入れる（1 つでも
  // 非 skip があれば gate すると判定するには、skip 側の出現も含めて全部見る必要が
  // ある）一方、代表値（`name` / `unresolved`）は**非 skip の出現でしか更新しない**。
  // ここを skip 側の出現でも無条件更新すると、gate を成立させた非 skip の出現より
  // 後ろに skip 側の出現があるだけで、表の名前が「gate の原因でない信頼レジストリ」
  // にすり替わる（fail-open ではないが、「PR コメントを見れば何が gate の原因か
  // 分かる」という監査可能性そのものが壊れる — Round 3 実測）。digest-centric 側
  // （上のブロック）は isSkip フィルタを通過したエントリだけを gated/unresolved に
  // 書くので、信頼判定と表示名が構造的に同じ出現を共有する。ここでも同じ不変条件
  // （表示名は必ず gate を成立させた非 skip の出現から採る）に揃える。
  const pairNames = new Map();  // pairKey(key, digest) -> { names: Set<name>, anyUnresolved, name, unresolved }
  // key ごとに、**base（`-`）側**で観測した実効名の集合と、1 つでも未解決な出現が
  // あったかを覚えておく（item 4、下の「初回 pin 免除の精密化」で使う）。
  const baseNamesByKey = new Map();  // key -> { names: Set<name>, anyUnresolved }
  const pairKey = (key, digest) => `${key} ${digest}`;
  for (let i = 0; i < content.length; i++) {
    const { c, line } = content[i];
    const target = c === '+' ? newByTag : c === '-' ? oldByTag : null;
    if (!target) { continue; }
    assertKnownDigestAlgos(line);
    // No `@sha256:` -> no ref; skip before matchAll (a prefilter that caps REF's
    // cost on long non-ref lines).
    if (!line.includes('@sha256:')) { continue; }
    assertScannableLine(line);
    for (const m of line.matchAll(REF)) {
      const key = m[1];
      let set = target.get(key);
      if (!set) { target.set(key, set = new Set()); }
      set.add(m[2]);
      const { name, unresolved } = resolve(i, m);
      if (c === '+') {
        const pk = pairKey(key, m[2]);
        let info = pairNames.get(pk);
        if (!info) { pairNames.set(pk, info = { names: new Set(), anyUnresolved: false }); }
        info.names.add(name);
        if (unresolved) { info.anyUnresolved = true; }
        if (!isSkip(name)) {
          info.name = name;
          info.unresolved = unresolved;
        }
      } else {
        let binfo = baseNamesByKey.get(key);
        if (!binfo) { baseNamesByKey.set(key, binfo = { names: new Set(), anyUnresolved: false }); }
        binfo.names.add(name);
        if (unresolved) { binfo.anyUnresolved = true; }
      }
    }
  }
  for (const [key, digests] of newByTag) {
    const olds = oldByTag.get(key);
    // key absent from the base = an initial pin, not a pure bump: left to
    // native minimumReleaseAge (default mode's historical scope).
    if (!olds) { continue; }
    // key が base に**ある**ことは「同じ raw tag トークンの出現が base 側にも
    // あった」以上の意味を持たない。分割形式では key が tag だけ（`latest` 等）で
    // registry を持たないため、同じ diff 内の**無関係な 2 つのイメージ**がキーを
    // 共有しうる（item 4）: 片方が `latest` を正当に bump し、もう片方がたまたま
    // 同じ `latest` で初回 pin されただけでも、後者は前者の base 出現のおかげで
    // 「base に既存の key」判定を通ってしまい、免除されるべき初回 pin が gate
    // されていた。1 行形式では key（raw トークン）が実効名そのものなので起こらない
    // 事故 — 分割形式だけが踏む非対称。
    const base = baseNamesByKey.get(key) ?? { names: new Set(), anyUnresolved: false };
    // 名前の重なり判定は normalizeImageName を通してから行う。isSkipRef が
    // prefix / ref の両側を normalizeImageName で正規化して比較しているのと
    // 対称に揃える — ここだけ生文字列比較だと、`docker.io/` 別名で綴りが変わる
    // だけの本当に同一のイメージ（`docker.io/bitnami/nginx` と `bitnami/nginx`）が
    // 「別イメージの初回 pin」に誤判定されて免除されてしまう（このリポが繰り返し
    // 記録してきた「片側だけ正規化して非対称になる」バグの別形）。正規化は
    // **一致しやすくなる方向**にしか働かないので、`sameImage` が真になりやすくなる
    // だけ = より多く bump として gate される（fail-closed 方向）で安全側。
    // 限界: Docker 公式イメージの暗黙 `library/` 補完は normalizeImageName が
    // 行わない（同関数のコメント参照）ので、`nginx` と `docker.io/library/nginx`
    // はここでも依然一致しない。
    const baseNormNames = new Set([...base.names].map((n) => normalizeImageName(n)));
    for (const digest of digests) {
      // A new digest under a tag that already existed in the base = a bump.
      // A digest also present in the base is unchanged (reformat/re-listing).
      if (olds.has(digest)) { continue; }
      const info = pairNames.get(pairKey(key, digest));
      if ([...info.names].every((n) => isSkip(n))) { continue; }
      // 初回 pin 免除の精密化（item 4）: 同一性キーは解決状態から独立させたまま
      // （Round 2 の理由は生きている — 名前行の削除/変更/追加でキーが割れて
      // 非 gate になる穴を再開通させない）、**初回 pin 免除だけ**を名前で絞り込む。
      // base 側とこの (key, digest) の head 側が「同じイメージを指しうる」のは:
      //   - どちらかの実効名が解決できていない（ambiguous → 同じ image かもしれない
      //     ことを否定できないので fail-closed 側 = gate する）、または
      //   - 解決できた実効名同士が正規化後に 1 つでも重なる（本当に同じ image の bump）
      // という条件。両方とも解決できていて、かつ名前が 1 つも重ならないときだけ
      // 「たまたま同じ tag トークンを共有する別イメージ」と断定して免除する。
      // `anyUnresolved`（base / info とも）は blockNameFor が「tag 行だがスパンが
      // 一致しなかった」を `null` で返すことに由来する（上のコメント参照）。
      // digest-centric ではその区別は可視化のみだが、ここ（pure-bump）では
      // `anyUnresolved` を経由して **gate 判定そのものの入力**になる —
      // 判定不能な出現を「解決済みで名前が重ならない別イメージ」と誤断しないための
      // 結合であり、意図した依存。
      const sameImage = base.anyUnresolved || info.anyUnresolved
        || [...info.names].some((n) => baseNormNames.has(normalizeImageName(n)));
      if (!sameImage) { continue; }
      // `info.name` は必ず設定済み: この for ループへ来る時点で `info.names` に
      // 非 skip の要素が最低 1 つある（直上の every(isSkip) を抜けた）ので、
      // その出現で `info.name` が上で更新されている（skip 側の出現しか無ければ
      // `info.name` は undefined のままここへは来ない）。
      gated[digest] = info.name;
      // 同じ (key, digest) ペアの最後の**非 skip**出現から gated[] と unresolved[]
      // を決める（E、上の digest-centric 側と同じ理由）。
      if (info.unresolved) { unresolved[digest] = info.name; } else { delete unresolved[digest]; }
    }
  }
  return { gated, unresolved };
}

// Decide whether a PR gets the broad digest-centric strategy or the
// default pure-digest-bump baseline. Pure so it is directly unit-testable
// (like parseDiff): the digest-centric gate is enabled only when
// gate-version-bumps is on AND the author is in scope (empty gateAuthors =
// every author in scope). An out-of-scope author falls back to the default
// baseline, so opt-in never gates *less* than default for anyone. Returns
// the digestCentric boolean.
export function resolveStrategy(author, gateVersionBumps, gateAuthors) {
  const authorInScope = gateAuthors.length === 0 || gateAuthors.includes(author);
  return gateVersionBumps && authorInScope;
}

// Decide whether the emergency-bypass label is attached to a PR. Pure so it is
// directly unit-testable (like resolveStrategy). `labelNames` are the PR's
// label names; `bypassLabel` is the single configured label name -- exactly one
// label designates the bypass, so a search for that one name finds every
// bypassed PR. The comparison is case-insensitive, but the *matched PR-side*
// name (its original casing) is returned for display so the audit trail shows
// the label exactly as it appears on the PR. An empty/unset value means the
// feature is off, so it can never match -- returns null. This is not a
// security boundary: it is an explicit, auditable override by whoever holds
// triage rights to label the PR.
export function resolveBypass(labelNames, bypassLabel) {
  if (!bypassLabel) { return null; }
  const wanted = bypassLabel.toLowerCase();
  for (const name of labelNames) {
    if (typeof name === 'string' && name.toLowerCase() === wanted) { return name; }
  }
  return null;
}

// 与えられた候補 commit status から、指定 context の state を引く。
// 責務は「context 一致 → creator 検証 → state を返す」の 3 つだけ。context が
// 不在なら null（= その status がまだ投稿されていない）。純粋なので resolveBypass
// 同様に直接ユニットテストできる。
//
// run() は list endpoint の応答を latestStatusForContext で **最新 1 件**に絞ってから
// 渡すので、実際の運用では候補は 0 件か 1 件しか来ない。複数渡された場合の合成規則は
// 「**全件が success のときだけ success**、1 件でも非 success があればそれを採る」
// という順序非依存の fail-closed を保持している（直接呼ぶユニットテストや将来の
// 呼び出し側に対する防御。「先頭 1 件を採る」だと先頭が stale な success で後方が
// failure のとき fail-**open** になる）。
//
// creator 検証: `trustedCreators` が空でなければ、status の投稿者
// （Statuses API の `creator.login`）が allowlist に含まれることも要求し、含まれない
// 場合は `'untrusted-creator'`（= 非 success なので fail-closed）を返す。これは
// findComment が state コメントを TRUSTED_COMMENT_AUTHOR で絞っているのと対称の防御で、
// status 側にだけこの対称性が欠けていた。比較は case-insensitive。
// ⚠️ この検証は **list endpoint の応答**でしか成立しない。Combined Status API
// （`GET /commits/{ref}/status`）の `statuses[]` には `creator` が存在せず（実 API で
// 実測確認済み）、login が常に空文字になるため、既定の非空 allowlist の下では
// すべての status が `untrusted-creator` に落ちて機能が丸ごと死ぬ。呼び出し側の
// endpoint を変えるときはここを必ず読むこと。
// この機構の防御上限: `statuses: write` を持つ者（write 権限保有者・任意の GitHub App）は
// 前提 status を**自作できる**。allowlist は「bot が投稿した status」に見せかける手間を
// 増やすだけで、write 権限保有者に対する防御にはならない（詳細は docs）。
//
// 対象は Statuses API の commit status のみ。GitHub Actions の check run
// （job 名）は Statuses API に載らないので、job 名を指定しても常に不在
// （null）になる。
// 返り値: 'success' | 'pending' | 'failure' | 'error' | 'untrusted-creator' | null
export function resolveRequiredStatus(statuses, context, trustedCreators = []) {
  if (!Array.isArray(statuses)) { return null; }
  const allow = (trustedCreators || [])
    .map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean);
  const found = [];
  for (const s of statuses) {
    if (!s || s.context !== context) { continue; }
    if (allow.length > 0) {
      const login = String((s.creator && s.creator.login) || '').toLowerCase();
      if (!allow.includes(login)) { found.push('untrusted-creator'); continue; }
    }
    found.push(s.state ?? null);
  }
  if (found.length === 0) { return null; }
  if (found.every((st) => st === 'success')) { return 'success'; }
  // 非 success を優先する（どれを理由として返すかは配列順で決まるが、success か
  // 否かの判定自体は順序に依存しない）。値が null（state 欠落）ならそのまま null を
  // 返し、呼び出し側で `missing` に寄せる従来の扱いを保つ。
  return found.find((st) => st !== 'success') ?? null;
}

// list endpoint（`GET /repos/{owner}/{repo}/commits/{ref}/statuses`）が返す
// commit status 配列から、指定 context の **最新 1 件**を採る。不在なら null。
//
// なぜ最新 1 件か: combined status（`/commits/{ref}/status`）が context ごとに
// 1 件へ集約するのに対し、list は同一 context の**履歴を全部**返す。実測（同一 commit）:
//   list     : digest-cooldown success 02:55:20 / success 02:10:59 / pending 01:32:28 / pending 18:52:40
//   combined : digest-cooldown success 02:55:20
// よって「全件 success のときだけ success」を履歴全体へ適用すると、過去に一度でも
// pending を出していれば**永久に否決**される。GitHub 自身の判定（combined / branch
// protection）と同じく、context ごとの最新 1 件がその context の現在値である。
//
// 実測では list は新しい順（reverse chronological）に返るが、これは docs.github.com に
// 明文化された保証ではないので、無根拠な順序依存を作らず `updated_at` 降順で明示的に
// ソートしてから採る。`updated_at` を読めないエントリは -Infinity 扱いで後ろへ回し、
// 全件読めない場合は安定ソートにより配列順（= 実測の新→古）へフォールバックする。
export function latestStatusForContext(statuses, context) {
  if (!Array.isArray(statuses)) { return null; }
  const matched = statuses.filter((s) => s && s.context === context);
  if (matched.length === 0) { return null; }
  const at = (s) => {
    const t = Date.parse(s.updated_at ?? s.created_at ?? '');
    return Number.isFinite(t) ? t : -Infinity;
  };
  // Array#sort は ES2019 以降 stable なので、同着（両方 -Infinity 含む）は元の順序を保つ。
  return [...matched].sort((a, b) => at(b) - at(a))[0];
}

export async function run({ github, context, core }) {
  const COOLDOWN_DAYS = Number(process.env.COOLDOWN_DAYS || '3');
  const SKIP = (process.env.SKIP_REGISTRIES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const PR_NUMBER = (process.env.PR_NUMBER || '').trim();
  const BASE_BRANCHES = (process.env.BASE_BRANCHES || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const DRY_RUN = process.env.DRY_RUN === 'true';
  const ALWAYS_REPORT = process.env.ALWAYS_REPORT === 'true';
  const GATE_VERSION_BUMPS = process.env.GATE_VERSION_BUMPS === 'true';
  const GATE_AUTHORS = (process.env.GATE_AUTHORS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const TRUSTED_COMMENT_AUTHOR = process.env.TRUSTED_COMMENT_AUTHOR || 'github-actions[bot]';
  const BYPASS_LABEL = (process.env.BYPASS_LABEL || '').trim();
  const BYPASS_REQUIRES_STATUS = (process.env.BYPASS_REQUIRES_STATUS || '').trim();
  // 前提 status の投稿者 allowlist。空なら creator を検証しない（後方互換）。
  // 既定は action.yml 側で `github-actions[bot]`。
  const BYPASS_REQUIRES_STATUS_CREATORS = (process.env.BYPASS_REQUIRES_STATUS_CREATORS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  // NOW is the instant the cooldown is measured against; TODAY stays available
  // as a date-granular override (tests, and callers pinning a day). Deriving
  // TODAY from NOW keeps the two in step.
  const NOW = process.env.NOW
    || (process.env.TODAY ? `${process.env.TODAY}T00:00:00Z` : new Date().toISOString());
  const TODAY = NOW.slice(0, 10);

  const { owner, repo } = context.repo;
  if (DRY_RUN) {
    core.warning('DRY RUN: no status or comment will be posted');
  }

  // セグメント境界一致（isSkipRef）。素の startsWith だと skip prefix
  // `ghcr.io/animalife` が `ghcr.io/animalife-evil/x` にも一致して冷却ゲートを
  // 素通りできた（同関数のコメント参照）。verify-image-provenance も同じ関数を
  // import して使うので、両アクションの skip-registries は同一の意味になる。
  const isSkip = (name) => isSkipRef(name, SKIP);

  // isValidDate / ageDays / sortedState / sameBody / renderComment are now
  // top-level pure exports (see the module header); run() passes COOLDOWN_DAYS
  // and TODAY in explicitly.

  const findComment = async (num) => {
    const comments = await github.paginate(github.rest.issues.listComments, {
      owner, repo, issue_number: num, per_page: 100,
    });
    for (const c of comments) {
      // Only a digest-cooldown state comment is a candidate; ordinary human
      // comments (no MARKER) are not our concern and must not be logged
      // about -- warning on them would just be noise on every PR discussion.
      if (!c.body || !c.body.includes(MARKER)) { continue; }
      // Only trust a state comment authored by TRUSTED_COMMENT_AUTHOR. The
      // stored first-seen dates drive the cooldown, so an attacker who posts
      // a back-dated state comment before the bot could otherwise forge an
      // "already aged" state and clear the gate. A MARKER-bearing comment
      // from anyone else is a likely back-date spoof attempt: surface it
      // with a warning instead of silently skipping, then ignore it (the
      // bot creates its own state comment on this run).
      if (!c.user || c.user.login !== TRUSTED_COMMENT_AUTHOR) {
        core.warning(`Ignoring untrusted digest-cooldown state comment on #${num} authored by ${c.user?.login || 'unknown'} (only ${TRUSTED_COMMENT_AUTHOR} is trusted)`);
        continue;
      }
      const m = STATE_RE.exec(c.body);
      return { id: c.id, state: m ? JSON.parse(m[1]) : {}, body: c.body };
    }
    return { id: null, state: {}, body: null };
  };

  const upsertComment = async (num, cid, body) => {
    if (DRY_RUN) {
      core.info(`[dry-run] ${cid ? 'update' : 'create'} comment on #${num}:\n${body}`);
      return;
    }
    if (cid) {
      await github.rest.issues.updateComment({ owner, repo, comment_id: cid, body });
    } else {
      await github.rest.issues.createComment({ owner, repo, issue_number: num, body });
    }
  };

  const setStatus = async (sha, state, description) => {
    if (DRY_RUN) {
      core.info(`[dry-run] status ${state} on ${sha.slice(0, 12)}: ${description}`);
      return;
    }
    await github.rest.repos.createCommitStatus({
      owner, repo, sha, state, context: CONTEXT,
      description: description.slice(0, 140), target_url: TARGET_URL,
    });
  };

  // Merge queue. A merge_group run has no PR of its own: GitHub builds a
  // temporary commit on `gh-readonly-queue/<base>/pr-<N>-<base_sha>` and the
  // required contexts must be reported on *that* commit, otherwise the queue
  // entry never merges. The cooldown itself was already decided on the PR
  // head (a PR cannot enter the queue until `digest-cooldown` is success
  // there), and the digests in the group are exactly those of that head, so
  // the verdict carries over: read the PR head's latest `digest-cooldown`
  // status, require it to be success and posted by a trusted creator, and
  // mirror it onto the merge-group head. Anything else (missing, pending,
  // untrusted creator, unparseable ref, API failure) posts pending, which is
  // the fail-closed side for a required check.
  if (context.eventName === 'merge_group') {
    const MERGE_GROUP_STATUS_CREATORS = (process.env.MERGE_GROUP_STATUS_CREATORS || '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const mg = (context.payload && context.payload.merge_group) || {};
    const headSha = String(mg.head_sha || context.sha || '');
    const headRef = String(mg.head_ref || '');
    const pending = async (why) => {
      core.warning(`digest-cooldown (merge group): ${why}`);
      await setStatus(headSha, 'pending', `merge group: ${why}`);
    };
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      core.warning('digest-cooldown (merge group): no usable merge-group head SHA; nothing to report on');
      return;
    }
    const m = /\/pr-(\d+)-[0-9a-f]{40}$/.exec(headRef);
    if (!m) {
      await pending(`cannot derive the PR number from ref '${headRef}'`);
      return;
    }
    const prNumber = Number(m[1]);
    try {
      const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: prNumber });
      const prHead = String((pr.head && pr.head.sha) || '');
      if (!/^[0-9a-f]{40}$/.test(prHead)) {
        await pending(`PR #${prNumber} has no readable head SHA`);
        return;
      }
      const statuses = await github.paginate(
        github.rest.repos.listCommitStatusesForRef,
        { owner, repo, ref: prHead, per_page: 100 },
      );
      if (!Array.isArray(statuses)) {
        throw new TypeError(`unexpected commit-status list response type '${typeof statuses}'`);
      }
      const latest = latestStatusForContext(statuses, CONTEXT);
      const st = resolveRequiredStatus(latest ? [latest] : [], CONTEXT, MERGE_GROUP_STATUS_CREATORS);
      if (st !== 'success') {
        await pending(`PR #${prNumber} head ${prHead.slice(0, 12)} has ${CONTEXT} = ${st || 'missing'}`);
        return;
      }
      await setStatus(headSha, 'success',
        `mirrors ${CONTEXT} success on PR #${prNumber} head ${prHead.slice(0, 12)}`);
      core.info(`merge group for PR #${prNumber}: ${CONTEXT} success on head ${prHead.slice(0, 12)} -> success on ${headSha.slice(0, 12)}`);
    } catch (e) {
      try {
        await pending(`failed to read PR #${prNumber}: ${e.message}`);
      } catch (e2) {
        core.warning(`digest-cooldown (merge group): also failed to post the fail-closed pending status: ${e2.message}`);
      }
    }
    return;
  }

  // Enumerate target PRs.
  let prs;
  if (PR_NUMBER) {
    const { data } = await github.rest.pulls.get({
      owner, repo, pull_number: Number(PR_NUMBER),
    });
    prs = [data];
    core.info(`Targeting PR #${PR_NUMBER}`);
  } else {
    prs = await github.paginate(github.rest.pulls.list, {
      owner, repo, state: 'open', per_page: 100,
    });
    core.info(`Scanning ${prs.length} open PR(s)`);
  }

  // Restrict to PRs whose base is a gated branch. Renovate opens its
  // PRs against the base branch(es); promotion PRs (e.g. develop ->
  // release/main) carry digests that already cleared cooldown on the
  // base, so re-gating them only blocks the promotion. Defaults to the
  // repository's default branch when BASE_BRANCHES is unset.
  let gatedBases = BASE_BRANCHES;
  if (gatedBases.length === 0) {
    const { data: repoData } = await github.rest.repos.get({ owner, repo });
    gatedBases = [repoData.default_branch];
  }
  core.info(`Gating PRs based on: ${gatedBases.join(', ')}`);
  prs = prs.filter((pr) => {
    if (gatedBases.includes(pr.base.ref)) {
      return true;
    }
    core.info(`PR #${pr.number}: base '${pr.base.ref}' not gated; skipped`);
    return false;
  });

  // Track whether the digest-centric strategy was actually applied to any PR
  // this run. When gate-version-bumps is on but it matched nothing, the
  // gate-authors list likely does not match the real PR author login(s), so
  // the run silently degraded to the pure-digest-bump baseline (see the
  // warning after the loop).
  let anyDigestCentric = false;
  for (const pr of prs) {
    try {
      // GATE_AUTHORS scopes only *which strategy* an opt-in run uses, not
      // whether the PR is gated at all: in-scope authors (default
      // renovate[bot]) get the broad digest-centric gate; out-of-scope
      // authors fall back to the default pure-digest-bump gate. So every
      // author keeps at least the historical baseline -- scoping an author
      // out cannot fail open (it can never gate *less* than default). This
      // is the fallback guarantee only, not "opt-in ⊇ default": for an
      // in-scope author digest-centric can gate less than default on a
      // re-pin to a base digest (see the module header). Empty GATE_AUTHORS
      // = digest-centric for all authors. In default mode
      // (GATE_VERSION_BUMPS=false) the strategy is always pure-digest-bump
      // regardless of author.
      const author = (pr.user && pr.user.login) || '';
      const digestCentric = resolveStrategy(author, GATE_VERSION_BUMPS, GATE_AUTHORS);
      // "applied" == the digest-centric strategy was *attempted* for this PR
      // (the author is in scope and the mode is on). It is set before the
      // diff is fetched, so it does not mean any digest was actually gated --
      // only that the broad strategy ran. Used solely to detect a mis-scoped
      // gate-authors list (warning after the loop), never a gate outcome.
      if (digestCentric) { anyDigestCentric = true; }
      const { data: diff } = await github.rest.pulls.get({
        owner, repo, pull_number: pr.number,
        mediaType: { format: 'diff' },
      });
      core.info(`PR #${pr.number}: strategy=${digestCentric ? 'digest-centric' : 'pure-bump'} author=${author}`);
      // TOCTOU ガード（verify-image-provenance と同じ形）。`pr.head.sha` は最初の
      // `pulls.get` / `pulls.list` から採り、判定に使う diff は**その後**の別呼び出し
      // から採るので、2 つの API 呼び出しの間に push が入ると「新しい（gate 対象ゼロの）
      // diff から出た success を古い SHA に貼る」ことになる。攻撃としては数百 ms の
      // レースだが、**Renovate の rebase のような事故**でも成立するので、修正コストの
      // 安さを理由に閉じる。不一致ならこの PR は投稿せず skip し、新しい SHA に対する
      // run（push が起こす）に委ねる。
      const { data: prNow } = await github.rest.pulls.get({
        owner, repo, pull_number: pr.number,
      });
      const headNow = (prNow && prNow.head && prNow.head.sha) || '';
      if (headNow !== pr.head.sha) {
        core.notice(`digest-cooldown: PR #${pr.number} head moved while reading the diff (${pr.head.sha.slice(0, 12)} -> ${headNow.slice(0, 12) || 'unknown'}); skipping so the run for the new SHA decides`);
        continue;
      }
      // diff が文字列でない（mediaType が効かず PR の JSON が返る等の応答形状変化）
      // ケースを、空 diff に潰して「gate すべき digest なし」と縮退させてはいけない。
      // always-report と組み合わさると `digest-cooldown: success` を投稿してしまい、
      // 診断の痕跡も残らない silent な fail-open になる。「判定できなかった」は
      // 「冷却済み」ではないので、warning を出して pending 側（fail-closed）に倒す。
      if (typeof diff !== 'string') {
        core.warning(`digest-cooldown: unexpected diff response type '${typeof diff}' for #${pr.number}; cannot judge the cooldown (fail-closed)`);
        await setStatus(pr.head.sha, 'pending',
          `unable to read the PR diff (unexpected response type '${typeof diff}'); cooldown not cleared`);
        continue;
      }
      // 分割形式で image 名（= registry）を判定できなかった gate 対象。fail-closed 側
      // （外部イメージとして冷却）に倒すのは従来どおりだが、判定**できた**外部イメージと
      // 見分けが付かないまま黙って冷却するのはやめる（issue #21）。ログと PR コメントの
      // 両方に出して、`skip-registries` が効いていないことを気づけるようにする。
      // F: parseDiff は onUnresolvedName コールバックではなく { gated, unresolved } を
      // 返す（この codebase に「出力を副作用コールバックで返す」先例が無い。isSkip は
      // 逆に *入力* の注入であって性質が違う）。
      const { gated, unresolved } = parseDiff(diff, digestCentric, isSkip);
      const unresolvedEntries = Object.entries(unresolved);
      if (unresolvedEntries.length > 0) {
        // G: core.warning に埋め込む前に、renderComment の NAME_MAX 切り詰めと同じ
        // ロジックで token を切り詰め、列挙件数にも上限を置く。トリムしないと
        // PR 作者が制御する image 名候補を無制限に warning へ埋め込めてしまう
        // （1 本あたり最大 4096B の PR-controlled 文字列 × 本数無制限）。
        const WARN_LIST_MAX = 10;
        const truncate = (s) => (s.length > NAME_MAX ? `${s.slice(0, NAME_MAX)}…` : s);
        const shownEntries = unresolvedEntries.slice(0, WARN_LIST_MAX);
        const shown = shownEntries
          .map(([dig, token]) => `${truncate(token)}@${dig.slice(0, 19)}…`).join(', ');
        const more = unresolvedEntries.length > WARN_LIST_MAX
          ? `, …and ${unresolvedEntries.length - WARN_LIST_MAX} more` : '';
        core.warning(`digest-cooldown: #${pr.number}: ${unresolvedEntries.length} ref(s) are pinned in a split form whose image name is not in the diff (${shown}${more}); skip-registries cannot be applied, gating them as external`);
      }
      if (Object.keys(gated).length === 0) {
        // No external digest to gate. When this status is wired as a
        // branch-protection *required* check it must be reported on
        // every gated-base PR, else unreported PRs deadlock ("Waiting
        // for status to be reported"). always-report posts success so
        // the context is always present; otherwise stay silent (the
        // Renovate-automerge-only mode, which honours non-required
        // statuses and needs no status on digest-less PRs).
        if (ALWAYS_REPORT) {
          await setStatus(pr.head.sha, 'success', 'no external image digest bumps to gate');
          core.info(`PR #${pr.number}: no external digest bump -> success (always-report)`);
        } else {
          core.info(`PR #${pr.number}: no external digest bump; skipped`);
        }
        continue;
      }

      // Emergency-bypass: a triage-authorised label on the PR forces the
      // status to success even while digests are still cooling. Only resolved
      // when there is something to gate (the always-report/no-digest path
      // above never carries a bypass, so its wording stays unambiguous). The
      // bypass affects the *status* only -- the state comment and first-seen
      // dates below are written exactly as without a label, so removing the
      // label resumes the cooldown from the original observation date.
      const labelNames = (pr.labels ?? [])
        .map((l) => (typeof l === 'string' ? l : l && l.name))
        .filter(Boolean);
      const bypassLabel = resolveBypass(labelNames, BYPASS_LABEL);

      // bypass-requires-status: label だけでバイパスを許すのではなく、指定した
      // commit status context が success であることを前提条件にする（主用途は
      // verify-image-provenance が「その image は署名・出自検証を通った」と
      // 報告している場合にだけ緊急バイパスを許す運用）。空（既定）なら前提なし
      // ＝従来挙動。前提を確認できないケース（context 不在・failure/pending/error・
      // 自己参照の設定ミス）はすべて fail-closed でバイパス不適用にする。
      // API は「label が一致し、かつ前提が設定されている」ときだけ引く（label の
      // 無い大多数の PR で無駄な status 照会をしない）。
      let bypassEffective = bypassLabel !== null;
      // 不適用理由（'missing' / status state / 'self-reference'）。pending status の
      // description と監査 notice に出して「label は付いているが効いていない」を
      // PR 上から読めるようにする。
      let bypassDenied = null;
      if (bypassLabel && BYPASS_REQUIRES_STATUS) {
        if (BYPASS_REQUIRES_STATUS.toLowerCase() === CONTEXT.toLowerCase()) {
          // 自分自身の status を前提にすると、バイパスは「自分が success で
          // ある」ことを要求する = 冷却中は永久に success へ到達できない
          // deadlock になる。設定ミスなので警告して不適用（fail-closed）。
          // 比較は resolveBypass と揃えて case-insensitive。commit status の
          // context 自体は case-sensitive だが、ここは「自己参照という設定ミス」を
          // 取りこぼさないためのガードなので、case 違い（`Digest-Cooldown` 等）も
          // 同一視して fail-closed 側に倒す。
          core.warning(`digest-cooldown: bypass-requires-status is set to this action's own context '${CONTEXT}'; that can never be satisfied (deadlock). Ignoring the bypass label on #${pr.number}`);
          bypassEffective = false;
          bypassDenied = 'self-reference';
        } else {
          // status 照会の失敗（rate limit / 5xx / 想定外の応答形状）は
          // 「前提を確認できなかった」であって「満たした」ではない。下の comment
          // upsert と同じ隔離方針で、例外を外側 catch に飛ばさず fail-closed でバイパスを落とし、
          // 下の setStatus（gate の本体）には必ず到達させる。飛ばすと status 未更新
          // のまま握り潰され、required check の deadlock になりうる。
          //
          // 応答の読み取り（形状チェックと resolveRequiredStatus 呼び出し）まで try の
          // 内側に置くのが要点。ここを try の外に出すと、配列でない応答での
          // TypeError が外側 catch に飛んで status 未投稿の deadlock 経路が復活する。
          try {
            // ⚠️ Combined Status API（`GET /commits/{ref}/status`）ではなく **list**
            // endpoint（`GET /commits/{ref}/statuses`）を引く。combined の応答の
            // `statuses[]` には `creator` が **存在しない**（実 API で実測確認済み）ため、
            // combined のままだと BYPASS_REQUIRES_STATUS_CREATORS の既定値
            // （`github-actions[bot]`）の下ですべての status が untrusted-creator に落ち、
            // bypass-requires-status が出荷既定で永久に効かなくなる。
            //
            // per_page 既定は 30。status を多く持つ commit で対象 context が 2 ページ目に
            // 落ちると `missing` の誤判定（＝正しく success なのにバイパスが効かない）に
            // なるため 100 を明示し、さらに paginate で全ページ読む。
            const statuses = await github.paginate(
              github.rest.repos.listCommitStatusesForRef,
              { owner, repo, ref: pr.head.sha, per_page: 100 },
            );
            // 想定外の応答形状（配列でない）は「読めなかった」として unreadable に
            // 倒す。空配列（= status ゼロ件）と区別するのが要点で、静かに `missing` へ
            // 縮退させると応答形状の変化が診断不能になる。
            if (!Array.isArray(statuses)) {
              throw new TypeError(`unexpected commit-status list response type '${typeof statuses}'`);
            }
            // list は同一 context の履歴を全部返すので、context ごとに最新 1 件だけを
            // 採ってから判定する（古い pending が永久に否決するのを防ぐ）。
            const latest = latestStatusForContext(statuses, BYPASS_REQUIRES_STATUS);
            const st = resolveRequiredStatus(
              latest ? [latest] : [], BYPASS_REQUIRES_STATUS, BYPASS_REQUIRES_STATUS_CREATORS);
            if (st !== 'success') {
              bypassEffective = false;
              // 空文字/未設定の state を `missing` に寄せる（`?? ` だと空文字が
              // そのまま残り「(bypass ignored: 'ctx' )」と理由が空になる）。
              bypassDenied = st || 'missing';
            }
          } catch (e) {
            core.warning(`digest-cooldown: failed to read the commit statuses of #${pr.number}: ${e.message}; ignoring the bypass label (fail-closed)`);
            bypassEffective = false;
            bypassDenied = 'unreadable';
          }
        }
      }

      const { id: cid, state, body: prevBody } = await findComment(pr.number);
      // first-seen per digest: keep the recorded date only if it is a valid
      // YYYY-MM-DD, else stamp TODAY. A malformed date would yield a NaN age
      // and fail open (see isValidDate).
      const newState = {};
      for (const dig of Object.keys(gated)) {
        // A truthy-but-invalid stored value is a spoof/corruption signal
        // (isValidInstant rejects "not-a-date" etc.): re-stamp NOW and warn
        // once. A falsy value is just an unrecorded digest (first sighting),
        // which is the normal path -- stay silent there.
        if (state[dig] && !isValidInstant(state[dig])) {
          core.warning(`digest-cooldown: ignoring malformed first-seen date for ${dig} on #${pr.number}, re-stamping now`);
        }
        // Legacy YYYY-MM-DD values are kept as-is (read as T00:00:00Z); only
        // new observations are stamped with a full instant.
        newState[dig] = isValidInstant(state[dig]) ? state[dig] : NOW;
      }
      // Re-render whenever the *displayed* comment would differ — not
      // only when stored state changes. The "Nd left" countdown is
      // derived from TODAY, so on a cron run the day after first
      // observation the state JSON is identical yet the text is stale.
      // Comparing the rendered body keeps the countdown in step with
      // the commit status (which is rewritten unconditionally below).
      const strategy = digestCentric ? 'digest-centric' : 'pure-bump';
      // コメントの注記行は「実際に効いているバイパス」だけ（bypassEffective）。
      // 前提 status を満たさず不適用の label を「バイパス中」と描くと監査で誤読される。
      const body = renderComment(newState, gated, COOLDOWN_DAYS, NOW, strategy,
        bypassEffective ? bypassLabel : null, Object.keys(unresolved));
      if (cid === null || !sameBody(prevBody, body)) {
        // Isolate the comment upsert: a comment-API failure (rate limit, a
        // giant PR-controlled body, transient 5xx) must not skip setStatus
        // below. Left in the shared try/catch it aborted to the outer handler
        // with the status un-updated -- swallowed as a per-PR warning, which
        // reads as pass-through and can deadlock a required check / fail open.
        // Warn and press on to the status, which is the gate of record.
        try {
          await upsertComment(pr.number, cid, body);
        } catch (e) {
          core.warning(`digest-cooldown: failed to upsert state comment on #${pr.number}: ${e.message}; proceeding to set status`);
        }
      }

      // Hours, not whole days: a calendar-day comparison clears the gate up to
      // a day early (see the instant helpers above). Rendered back as days.
      const remaining = Object.values(newState)
        .map((s) => remainingHours(s, NOW, COOLDOWN_DAYS))
        .filter((h) => h > 0);
      const count = Object.keys(newState).length;
      if (bypassDenied) {
        // 監査ログ: バイパスが「要求されたが効かなかった」ことも、効いたバイパスと
        // 同じ可視性（notice）で残す。remaining の有無に関わらず出すのが要点で、
        // 全 digest が既に冷却済み（status は通常の success）でも「label が貼られ
        // ていたが前提 status を満たしていなかった」痕跡は監査上必要になる。
        // status の結果自体はこれによって変わらない。
        core.notice(`digest-cooldown: PR #${pr.number} bypass label '${bypassLabel}' ignored: required status '${BYPASS_REQUIRES_STATUS}' is ${bypassDenied}`);
      }
      if (remaining.length > 0 && bypassEffective) {
        // Still cooling, but a bypass label overrides the gate to success. The
        // wording names the label and how many digests are still cooling so the
        // status itself records that this is an override, not a genuine clear.
        await setStatus(pr.head.sha, 'success',
          `cooldown bypassed via label '${bypassLabel}' (${remaining.length} digest(s) still cooling)`);
        // Audit log: which PR was bypassed with which label. notice() raises it
        // above ordinary info in the Actions run so an override is never silent.
        core.notice(`digest-cooldown: PR #${pr.number} cooldown bypassed via label '${bypassLabel}' while ${remaining.length} of ${count} external image digest(s) are still cooling`);
        core.info(`PR #${pr.number}: ${count} gated digest(s) -> success (bypassed via label '${bypassLabel}')`);
      } else if (remaining.length > 0) {
        // bypass label は付いているが前提 status（bypass-requires-status）を
        // 満たさず不適用だった場合、その事実を status description の末尾に
        // 付ける（setStatus 側の 140 字 cap 内で切られる）。label を付けた人が
        // 「なぜ通らないのか」を PR 上で読めるようにするため。
        const deniedNote = bypassDenied
          ? ` (bypass ignored: '${BYPASS_REQUIRES_STATUS}' ${bypassDenied})`
          : '';
        await setStatus(pr.head.sha, 'pending',
          `${Math.ceil(Math.max(...remaining) / 24)}d left before ${count} external image digest(s) clear the ${COOLDOWN_DAYS}d cooldown${deniedNote}`);
        core.info(`PR #${pr.number}: ${count} gated digest(s) -> pending${bypassDenied ? ` (bypass ignored: '${BYPASS_REQUIRES_STATUS}' ${bypassDenied})` : ''}`);
      } else {
        await setStatus(pr.head.sha, 'success',
          `${count} external image digest(s) aged >= ${COOLDOWN_DAYS}d`);
        core.info(`PR #${pr.number}: ${count} gated digest(s) -> success`);
      }
    } catch (e) {
      // one PR failing must not abort the scheduled scan of the rest
      core.warning(`Failed to process PR #${pr.number}: ${e.message}`);
      // ⚠️ ここを warning だけで終えると、**commit status も state コメントも一切
      // 投稿されないまま step が緑で終わる**。「判定できなかった」は「冷却済み」では
      // ないので、上の comment upsert 隔離と同じ方針で fail-closed に倒し、
      // best-effort で pending を投稿する（required check の deadlock は
      // 「success が付かない」側なので、pending は fail-open にはならない）。
      // 例: diff に prototype 名の image 行や MAX_SCAN_LINE 超の行を 1 本置くだけで
      // parseDiff を落とせるので、gate 対象の内容そのもので gate を消せてはいけない。
      // この setStatus 自体も失敗しうる（statuses API 障害・head SHA 不明）ので
      // さらに try で包み、失敗しても残りの PR の処理は続ける。
      try {
        await setStatus(pr.head.sha, 'pending',
          'digest-cooldown failed to evaluate this PR; treating as cooling (fail-closed)');
      } catch (e2) {
        core.warning(`digest-cooldown: also failed to post the fail-closed pending status on #${pr.number}: ${e2.message}`);
      }
    }
  }

  // gate-version-bumps was requested but the broad strategy reached no PR:
  // almost always a gate-authors/author-login mismatch (e.g. a self-hosted
  // Renovate App whose login is not `renovate[bot]`), which silently leaves
  // only the pure-digest-bump baseline in effect. Only warn on a *scan* run
  // (PR_NUMBER empty, every open PR walked): a single-PR run (pull_request
  // event) legitimately targets one human PR that is correctly out of scope
  // and falls back to the baseline, so warning there would fire on every such
  // PR as noise. A scan run seeing zero in-scope authors across all open PRs
  // is the real mis-scope signal (#2).
  if (!PR_NUMBER && GATE_VERSION_BUMPS && prs.length > 0 && !anyDigestCentric) {
    core.warning('gate-version-bumps=true but digest-centric applied to no PR; verify gate-authors matches the actual PR author login(s)');
  }
}
