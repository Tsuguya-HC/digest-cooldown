#!/usr/bin/env node
// digest-cooldown action のロジックテスト。
//
// action.yml の github-script ブリッジをそのまま抽出し、require(=impl.mjs) を
// 注入して実行する。ブリッジ → impl.mjs の require 経路ごと検証する統合テスト
// （出荷される action.yml + impl.mjs をまるっとローカルで回す）。octokit/core/
// context はスタブ。gh / ネットワーク不要ですべてスタブ上で完結する。
//
//   node tests/test-digest-cooldown.mjs
//
// 本番の github-script は require に wrapRequire を注入するが、絶対パスは
// native require に素通しされる（actions/github-script src/wrap-require.ts で
// 確認済み）ので、ここでは createRequire 由来の native require を GITHUB_ACTION_PATH
// 絶対パスに対して使い、ブリッジと等価な経路を再現する。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import {
  parseDiff, resolveStrategy, resolveBypass, resolveRequiredStatus,
  latestStatusForContext,
  isValidDate, ageDays, sortedState, sameBody, renderComment,
  // REF / hunkContentLines / isSkipRef / normalizeImageName / MAX_SCAN_LINE /
  // assertScannableLine（と sameBody）は verify-image-provenance が実際に import して
  // 再利用している公開面（issue #84）。ここで import しておくことで、export を外す/
  // リネームするとこのテストが即座に落ちる（公開面の意図しない破壊を検知する）。
  REF, hunkContentLines, isSkipRef, normalizeImageName, MAX_SCAN_LINE,
  // home fork: instant-precision cooldown + unknown-digest-algorithm gate.
  isValidInstant, elapsedHours, remainingHours, assertKnownDigestAlgos,
} from '../impl.mjs';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ACTION_DIR = join(__dirname, '..');
const ACTION_YML = join(ACTION_DIR, 'action.yml');

// action.yml の `script: |` ブロックを抽出する。action.yml には複数の `script: |`
// が現れうる（将来の別 step など）ので、正しいブリッジを狙い撃つためにアンカー
// コメント `# extractScript-anchor: digest-cooldown-bridge` の直後にある
// `script: |` を起点にする。アンカーが無い場合のみ、後方互換で最初の
// `script: |` にフォールバックする。
function extractScript() {
  const lines = readFileSync(ACTION_YML, 'utf8').split('\n');
  const anchor = lines.findIndex((l) => l.includes('extractScript-anchor: digest-cooldown-bridge'));
  let start;
  if (anchor !== -1) {
    start = lines.findIndex((l, i) => i > anchor && l.trimEnd().endsWith('script: |'));
  } else {
    start = lines.findIndex((l) => l.trimEnd().endsWith('script: |'));
  }
  if (start === undefined || start === -1) {
    throw new Error('script block not found in action.yml');
  }
  const indent = lines[start + 1].match(/^\s*/)[0].length;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      body.push('');
      continue;
    }
    if (line.match(/^\s*/)[0].length < indent) {
      break;
    }
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

const SHA = 'a'.repeat(40);
const DIG_OLD = 'sha256:' + '0'.repeat(64);
const DIG_NEW = 'sha256:' + '1'.repeat(64);

// action.yml の inputs から既定値を実物のまま読み取る。ハーネスの既定を
// ハードコードすると「action.yml の既定値では機能が死んでいる」構成がテストされない
// まま通ってしまう（実際にそうなっていた: creator 検証の既定値ドリフト）ので、
// 出荷される既定値をここから流し込んで構造的にドリフトを防ぐ。
function actionInputDefault(name) {
  const lines = readFileSync(ACTION_YML, 'utf8').split('\n');
  const start = lines.findIndex((l) => l === `  ${name}:`);
  if (start === -1) { throw new Error(`input '${name}' not found in action.yml`); }
  for (let i = start + 1; i < lines.length; i++) {
    if (/^ {2}\S/.test(lines[i])) { break; }
    const m = lines[i].match(/^ {4}default:\s*(.*)$/);
    if (m) { return m[1].trim().replace(/^(['"])(.*)\1$/, '$2'); }
  }
  throw new Error(`input '${name}' has no default in action.yml`);
}

// 指定 diff・既存コメント・TODAY でスクリプトを実行し、副作用を捕捉する。
// commitStatuses は listCommitStatusesForRef（`GET /commits/{sha}/statuses`）が
// 返す 1 ページ分の配列。bypass-requires-status の前提 status 判定に使う。
// headShaSequence: 非 diff の `pulls.get` が返す head SHA を呼び出し順に指定する。
// TOCTOU ガード（diff 取得後に head を引き直して不一致なら skip）の検証用で、
// 1 回目 = PR 列挙、2 回目 = 引き直し。配列を尽きたら最後の値を返し続ける。
// 未指定なら従来どおり常に SHA（head が動かない通常ケース）。
async function run({ diff, today, comment = null, env = {}, base = 'main', defaultBranch = 'main', openPrs = null, author = 'renovate[bot]', failCommentOps = false, labels = [], commitStatuses = [], failStatusList = false, malformedStatusList = false, headShaSequence = null, contextExtra = {}, failPullGet = false }) {
  const calls = { statuses: [], created: [], updated: [], warnings: [], infos: [], notices: [], statusListCalls: [] };
  let headShaCall = 0;
  const nextHeadSha = () => {
    if (!headShaSequence) { return SHA; }
    const i = Math.min(headShaCall++, headShaSequence.length - 1);
    return headShaSequence[i];
  };
  const github = {
    paginate: async (fn, params) => (await fn(params)).data,
    rest: {
      pulls: {
        get: async (params) => {
          if (failPullGet) { throw new Error('pulls API down'); }
          if (params.mediaType && params.mediaType.format === 'diff') {
            return { data: diff };
          }
          // author=null/undefined のときは `user` フィールドごと省略し、
          // pr.user が存在しない実際の応答（削除済みユーザ等）を再現する。
          const data = { number: params.pull_number, head: { sha: nextHeadSha() }, base: { ref: base }, labels: labels.map((name) => ({ name })) };
          if (author !== null && author !== undefined) {
            data.user = { login: author };
          }
          return { data };
        },
        list: async () => ({ data: openPrs || [] }),
      },
      issues: {
        listComments: async () => ({ data: comment ? [comment] : [] }),
        // failCommentOps=true で comment API を落とし、upsertComment 失敗時でも
        // setStatus に到達すること（comment 失敗隔離）を検証できるようにする。
        createComment: async (p) => { if (failCommentOps) { throw new Error('comment API down'); } calls.created.push(p); },
        updateComment: async (p) => { if (failCommentOps) { throw new Error('comment API down'); } calls.updated.push(p); },
      },
      repos: {
        get: async () => ({ data: { default_branch: defaultBranch } }),
        createCommitStatus: async (p) => { calls.statuses.push(p); },
        // 呼び出しを記録して「label 無し / bypass-requires-status 空のときは
        // 呼ばない（無駄 API 抑止）」も検証できるようにする。
        // Combined Status API（getCombinedStatusForRef）ではなく **list** endpoint。
        // 実 API の combined status は `creator` を返さないため、combined を使うと
        // creator 検証が原理的に成立しない（allowlist 既定値のまま全 status が
        // untrusted-creator に落ちる）。スタブも実 API 形状（履歴が新→古で全件、
        // creator と updated_at を持つ）に合わせる。
        listCommitStatusesForRef: async (p) => {
          calls.statusListCalls.push(p);
          if (failStatusList) { throw new Error('statuses API down'); }
          // malformedStatusList=true で `data` を欠く応答を返し、応答読み取りの
          // TypeError も fail-closed 経路（unreadable）に落ちることを検証する。
          if (malformedStatusList) { return {}; }
          return { data: commitStatuses };
        },
      },
    },
  };
  // contextExtra: eventName / payload / sha を足して merge_group 等のイベントを再現する。
  const context = { repo: { owner: 'animalife', repo: 'demo' }, ...contextExtra };
  // core.info/warning をキャプチャして返り値 calls に含める。既存テストは
  // calls.statuses 等のみ参照するため、warnings/infos 配列を「追加」する形で
  // 後方互換（観測性テスト #2/#7 でアサートする）。
  const core = {
    info: (m) => { calls.infos.push(m); },
    warning: (m) => { calls.warnings.push(m); },
    notice: (m) => { calls.notices.push(m); },
  };

  // github-script が composite action を materialise した先。ブリッジはここから
  // impl.mjs を require する。
  process.env.GITHUB_ACTION_PATH = ACTION_DIR;
  process.env.PR_NUMBER = '1';
  process.env.DRY_RUN = 'false';
  process.env.COOLDOWN_DAYS = '3';
  process.env.SKIP_REGISTRIES = 'ghcr.io/animalife';
  process.env.BASE_BRANCHES = '';
  process.env.ALWAYS_REPORT = 'false';
  process.env.GATE_VERSION_BUMPS = 'false';
  process.env.GATE_AUTHORS = 'renovate[bot]';
  process.env.TRUSTED_COMMENT_AUTHOR = 'github-actions[bot]';
  process.env.BYPASS_LABEL = '';
  process.env.BYPASS_REQUIRES_STATUS = '';
  // creator allowlist の既定は **action.yml の実既定値をそのまま**使う（出荷構成の再現）。
  // 以前はここを空文字にハードコードしていたため、「action.yml の既定値 × 実 API の
  // 応答形状」という出荷構成が一度もテストされず、既定で機能が死んでいる欠陥を通した。
  process.env.BYPASS_REQUIRES_STATUS_CREATORS =
    actionInputDefault('bypass-requires-status-creators');
  process.env.MERGE_GROUP_STATUS_CREATORS =
    actionInputDefault('merge-group-status-creators');
  // NOW (home fork) is reset every run: leaving a previous test's instant in the
  // environment would silently pin the clock for every later case.
  process.env.NOW = '';
  process.env.TODAY = today;
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
  }

  const script = extractScript();
  const fn = new Function('require', 'github', 'context', 'core',
    `"use strict"; return (async () => {\n${script}\n})();`);
  await fn(require, github, context, core);
  return calls;
}

let failures = 0;
function check(name, cond) {
  if (cond) {
    console.log(`✓ ${name}`);
  } else {
    console.log(`✗ ${name}`);
    failures++;
  }
}

const MARKER = '<!-- digest-cooldown -->';
// 信頼される作成者（既定 github-actions[bot]）。findComment が作成者検証する
// ため、state を読ませたいテストコメントには必ずこの user を付ける。
const BOT_LOGIN = 'github-actions[bot]';
const BOT = { login: BOT_LOGIN };

// list endpoint（`GET /commits/{sha}/statuses`）が返す commit status 1 件分。
// 実 API は context / state に加えて `creator` と `updated_at` を必ず返すので、
// スタブも同じ形にする。creator を省いたスタブ（＝combined status の形）を使うと、
// 出荷既定の allowlist で全 status が untrusted-creator に落ちる欠陥を検出できない。
// creator: null で「creator フィールドごと欠落した応答」を再現できる。
const st = (context, state, { creator = BOT_LOGIN, updatedAt = '2026-06-03T00:00:00Z' } = {}) => ({
  context,
  state,
  updated_at: updatedAt,
  ...(creator === null ? {} : { creator: { login: creator } }),
});
const stateComment = (state) => ({
  id: 99,
  user: BOT,
  body: `${MARKER}\nsome body\n<!-- digest-cooldown-state ${JSON.stringify(state)} -->`,
});

// Produce the canonical comment body the action renders for a given
// first-seen state + TODAY, by running it against a placeholder comment
// (whose body always differs, forcing an update we can capture).
async function renderBody(state, today, diff) {
  const c = await run({ diff, today, comment: stateComment(state) });
  return (c.updated[0] || c.created[0]).body;
}

// 外部イメージの純粋な digest bump。
const digestBumpDiff = [
  '--- a/Dockerfile',
  '+++ b/Dockerfile',
  `-FROM node:20@${DIG_OLD}`,
  `+FROM node:20@${DIG_NEW}`,
].join('\n');

const main = async () => {
  // Test 1: 新規 digest bump、本日初観測 -> pending + コメント作成
  {
    const c = await run({ diff: digestBumpDiff, today: '2026-06-03' });
    check('1: pending status posted', c.statuses.length === 1 && c.statuses[0].state === 'pending');
    check('1: status on head sha', c.statuses[0].sha === SHA);
    check('1: comment created', c.created.length === 1 && c.created[0].body.includes(DIG_NEW.slice(0, 19)));
  }

  // Test 2: 既存コメントに 3 日前の first-seen -> success
  // 表示が既に最新(rendered body 一致)なら更新しない（churn なし）
  {
    const state = { [DIG_NEW]: '2026-06-01' };
    const current = await renderBody(state, '2026-06-04', digestBumpDiff);
    const c = await run({
      diff: digestBumpDiff,
      today: '2026-06-04',
      comment: { id: 99, user: BOT, body: current },
    });
    check('2: success after cooldown', c.statuses.length === 1 && c.statuses[0].state === 'success');
    check('2: no comment churn when body already current', c.created.length === 0 && c.updated.length === 0);
  }

  // Test 2b (回帰): state は不変でも TODAY が進めばカウントダウンが古くなる。
  // 初観測日に描画した "3d left" のコメントが、2 日後の cron で "1d left" に
  // 更新されること（旧実装は state 不変ゆえ更新せず固まっていた）。
  {
    const state = { [DIG_NEW]: '2026-06-01' };
    const day0Body = await renderBody(state, '2026-06-01', digestBumpDiff); // "3d left"
    check('2b: stored body started at 3d left', /3d left/.test(day0Body));
    const c = await run({
      diff: digestBumpDiff,
      today: '2026-06-03',
      comment: { id: 99, user: BOT, body: day0Body },
    });
    check('2b: stale countdown refreshed', c.updated.length === 1 && /1d left/.test(c.updated[0].body));
    check('2b: still pending', c.statuses[0].state === 'pending');
  }

  // Test 3: first-party (skip-registries) は gate しない -> status なし
  {
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM ghcr.io/animalife/base:1@${DIG_OLD}`,
      `+FROM ghcr.io/animalife/base:1@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03' });
    check('3: skip-listed registry not gated', c.statuses.length === 0 && c.created.length === 0);
  }

  // Test 4: デフォルト(gate-version-bumps=false)では、タグ変更を伴う version
  // 更新は pure digest bump ではないので gate しない（後方互換: native の
  // minimumReleaseAge に委譲）。
  {
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM node:20@${DIG_OLD}`,
      `+FROM node:21@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03' });
    check('4: tag change not gated by default', c.statuses.length === 0);
  }

  // Test 4b (consistency/architecture MEDIUM 回帰): 削除行の実コンテンツが
  // `--` で始まり、diff の除去マーカー `-` と合わさって `---FROM ...` になっても、
  // default（pure digest bump）モードは `line.slice(0, 3) === '---'` の文字列
  // 一致ではなく hunk 構造で判定するため、file header と誤認して fail-open
  // しない。
  {
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `---FROM node:20@${DIG_OLD}`,
      `+FROM node:20@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03' });
    check('4b: pure digest bump gated even when the removed line renders as `---...`',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
  }

  // Test 4c (#11 last-wins 取りこぼし回帰): 既定モードで同一 image:tag が複数 digest を持ち、
  // 末尾で旧 digest を再掲しても、新 digest を取りこぼさず gate する。旧実装は image:tag
  // last-wins で newByTag[app:1.0]=DIG_OLD に潰れ、old と一致して fail-open（{}）だった。
  // name→Set 化でこれを塞ぐ。
  {
    const diff = [
      '--- a/compose.yml',
      '+++ b/compose.yml',
      `-image: app:1.0@${DIG_OLD}`,
      `+image: app:1.0@${DIG_NEW}`,
      `+image: app:1.0@${DIG_OLD}`,   // 末尾で旧 digest 再掲（last-wins なら新 digest が消える）
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03' });
    check('4c/#11: default gates the new digest despite a trailing re-listing of the old digest',
      c.statuses.length === 1 && c.statuses[0].state === 'pending'
      && c.created.length === 1 && c.created[0].body.includes(DIG_NEW.slice(0, 19)));
  }

  // Test 4d (#19 default multiplicity 回帰): opt-in の 4-opt-multiplicity と対称に、既定モードでも
  // 同一 image:tag が「本物の digest bump」と「reformat の未変更行」で重複しても、新 digest を
  // 取りこぼさず gate し、base に居る旧 digest は非 gate（多重度マスキング防止）。
  {
    const diff = [
      'diff --git a/docker-compose.yml b/docker-compose.yml',
      '--- a/docker-compose.yml',
      '+++ b/docker-compose.yml',
      '@@ -1,2 +1,2 @@',
      `-    image: node:20@${DIG_OLD}`,
      `+    image: node:20@${DIG_NEW}`,
      `-    image: node:20@${DIG_OLD}`,
      `+    image: node:20@${DIG_OLD}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03' });
    check('4d/#19: default gates only the new digest despite a reformatted duplicate of the old',
      c.statuses.length === 1 && c.statuses[0].state === 'pending'
      && /1 external image digest/.test(c.statuses[0].description)
      && c.created[0].body.includes(DIG_NEW.slice(0, 19))
      && !c.created[0].body.includes(DIG_OLD.slice(0, 19)));
  }

  // Test 4e (ReDoS 事前フィルタ): `@sha256:` を含まない極端に長い行があっても、matchAll を
  // 回さず（O(n²) 回避）結果に影響しない。長い非マッチ行と本物の bump が同居しても bump だけ
  // gate されることを機能面で固定する（時間 assert は環境依存で脆いので置かない）。
  {
    const longNoise = 'x'.repeat(100000);
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `+# ${longNoise}`,
      `-FROM node:20@${DIG_OLD}`,
      `+FROM node:20@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03' });
    check('4e/prefilter: long non-matching line does not affect gating (prefilter skips matchAll)',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
  }

  // Test 4f (comment DoS 隔離): upsertComment が失敗しても setStatus に必ず到達する。
  // 現状は upsertComment 例外が外側 catch に飛び status 未更新→握り潰し→fail-open/deadlock
  // だった。image 名が極端に長くても status は更新される。
  {
    const longName = 'evil/' + 'a'.repeat(500);
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM ${longName}:1@${DIG_OLD}`,
      `+FROM ${longName}:1@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', failCommentOps: true });
    check('4f/comment-isolation: status is still set when the comment upsert fails (no deadlock/fail-open)',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    check('4f/comment-isolation: comment-upsert failure is surfaced as a warning',
      c.warnings.some((w) => /failed to upsert state comment/.test(w)));
  }

  // Test 4g (image 名 truncate): 長い image 名はコメント表示で 120 文字 + `…` に
  // 切り詰められる（state JSON は digest キーなので不変）。
  {
    const longName = 'evil/' + 'b'.repeat(300);
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM ${longName}:1@${DIG_OLD}`,
      `+FROM ${longName}:1@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03' });
    check('4g/truncate: long image name is truncated in the comment table',
      c.created.length === 1
      && c.created[0].body.includes('evil/' + 'b'.repeat(115)) // 120 chars: 'evil/'(5)+115
      && !c.created[0].body.includes('b'.repeat(300)));
  }

  // Test 4i（既定モードの prototype 汚染): image 名が `Object.prototype` のプロパティ名
  // （`constructor` / `toString` / `valueOf` / `hasOwnProperty`）でも既定モードが正常に
  // gate する。旧実装は `oldByTag`/`newByTag` を素の `{}` で持ち
  // `(target[m[1]] ??= new Set()).add(...)` としていたため、継承プロパティが nullish で
  // ないので `??=` が代入せず `.add is not a function` で throw していた。
  // その例外は run() の per-PR catch に握り潰され、**commit status も state コメントも
  // 一切投稿されないまま step が緑で終わる**（= gate 対象の内容そのもので gate を消せる
  // fail-open）。diff に 1 行足せる者なら誰でも成立する。
  {
    // REF の name 部は `[A-Za-z0-9][A-Za-z0-9._/-]*` なので、tag を持たない ref
    // （`FROM constructor@sha256:...`）ではこれらの名前がそのままキーになる。
    const protoNames = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'];
    const skip = (n) => isSkipRef(n, ['ghcr.io/animalife']);
    for (const n of protoNames) {
      const diff = `-FROM ${n}@${DIG_OLD}\n+FROM ${n}@${DIG_NEW}`;
      let gated;
      try {
        gated = parseDiff(diff, false, skip).gated;
      } catch (e) {
        gated = `THREW: ${e.message}`;
      }
      check(`4i: default mode gates an image named '${n}' without throwing`,
        JSON.stringify(gated) === JSON.stringify({ [DIG_NEW]: n }));
    }
    // digest-centric 側は Set/配列なので元から無傷（対称性の回帰固定）。
    check('4i: digest-centric mode is unaffected by a prototype-named image',
      JSON.stringify(parseDiff(`+FROM constructor@${DIG_NEW}`, true, skip).gated)
      === JSON.stringify({ [DIG_NEW]: 'constructor' }));
    // 初回 pin（base に name 無し）は既定モードでは非 gate — prototype 名でも同じ。
    check('4i: prototype-named initial pin stays out of scope in default mode',
      Object.keys(parseDiff(`+FROM constructor@${DIG_NEW}`, false, skip).gated).length === 0);
    // `__proto__` 自体は vector ではない: REF は name の先頭に `[A-Za-z0-9]` を要求するので
    // 先頭のアンダースコアが落ち、キーは `proto__`（通常の文字列）になる。
    check('4i: a leading-underscore name cannot reach __proto__ (REF anchors on alnum)',
      JSON.stringify(parseDiff(`-FROM __proto__@${DIG_OLD}\n+FROM __proto__@${DIG_NEW}`, false, skip).gated)
      === JSON.stringify({ [DIG_NEW]: 'proto__' }));
    // end-to-end: status が実際に投稿される（旧実装は statuses=[] / warnings に例外）。
    const c = await run({
      diff: `--- a/Dockerfile\n+++ b/Dockerfile\n-FROM constructor@${DIG_OLD}\n+FROM constructor@${DIG_NEW}`,
      today: '2026-06-03',
    });
    check('4i: prototype-named image still gets a pending status end-to-end',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    check('4i: no swallowed exception warning for a prototype-named image',
      !c.warnings.some((w) => /Failed to process PR/.test(w)));
  }

  // Test 4j（走査行長キャップ / MAX_SCAN_LINE): REF の吸収 group は near-miss 行に対して
  // **行長の二次**なので（実測: 4KB=19ms / 32KB=1.2s / 64KB=4.6s、`pull_request_target`
  // では diff は PR 作者が制御できる入力）、`@sha256:` を含む行が MAX_SCAN_LINE を超えたら
  // 判定を諦めて throw する。run() の per-PR catch は fail-closed で pending を投稿するので、
  // 計算量を焼き切って gate を消すことはできない。
  {
    const skip = (n) => isSkipRef(n, ['ghcr.io/animalife']);
    check('4j: MAX_SCAN_LINE is exported as 4096', MAX_SCAN_LINE === 4096);
    // near-miss 行（`@sha256:` はあるが digest が 64hex に満たない）で 5KB。
    const nearMiss = `+FROM ${'}'.repeat(5000)}x@sha256:deadbeef`;
    check('4j: a line longer than MAX_SCAN_LINE throws in default mode',
      (() => { try { parseDiff(nearMiss, false, skip); return false; } catch (e) { return /diff line too long to scan/.test(e.message); } })());
    check('4j: a line longer than MAX_SCAN_LINE throws in digest-centric mode',
      (() => { try { parseDiff(nearMiss, true, skip); return false; } catch (e) { return /diff line too long to scan/.test(e.message); } })());
    // 4KB 未満の正常な ref 行は従来どおり gate される（キャップの副作用なし）。
    const padName = `pad/${'a'.repeat(3900)}`;
    const okDiff = `-FROM ${padName}:1@${DIG_OLD}\n+FROM ${padName}:1@${DIG_NEW}`;
    check('4j: a sub-cap line is unaffected',
      okDiff.split('\n').every((l) => l.length < MAX_SCAN_LINE)
      && JSON.stringify(parseDiff(okDiff, false, skip).gated) === JSON.stringify({ [DIG_NEW]: `${padName}:1` }));
    // `@sha256:` を含まない行は長さに関係なく素通り（既存 4e の事前フィルタは維持）。
    check('4j: a long line without @sha256: is not capped',
      JSON.stringify(parseDiff(
        `+# ${'x'.repeat(100000)}\n-FROM node:20@${DIG_OLD}\n+FROM node:20@${DIG_NEW}`, false, skip,
      ).gated) === JSON.stringify({ [DIG_NEW]: 'node:20' }));
    // end-to-end: キャップ超過 → per-PR catch が fail-closed で pending を投稿する。
    const c = await run({
      diff: ['--- a/Dockerfile', '+++ b/Dockerfile', nearMiss].join('\n'),
      today: '2026-06-03',
    });
    check('4j: an over-cap line falls back to a fail-closed pending status',
      c.statuses.length === 1 && c.statuses[0].state === 'pending'
      && /fail-closed/.test(c.statuses[0].description));
    check('4j: the swallowed exception is still surfaced as a warning',
      c.warnings.some((w) => /Failed to process PR #1/.test(w) && /too long to scan/.test(w)));
  }

  // Test 4k（TOCTOU: pr.head.sha と diff の乖離): head SHA は最初の `pulls.get` から採り、
  // 判定に使う diff は**その後**の別呼び出しから採るので、間に push が入ると
  // 「新しい（gate 対象ゼロの）diff から出た success を古い SHA に貼る」ことになる。
  // verify-image-provenance と同じ形（diff 取得後に head を引き直し、不一致なら skip）で閉じる。
  {
    const SHA2 = 'b'.repeat(40);
    const c = await run({
      diff: digestBumpDiff,
      today: '2026-06-03',
      headShaSequence: [SHA, SHA2],
    });
    check('4k/TOCTOU: nothing is posted when head moved between the PR and diff reads',
      c.statuses.length === 0 && c.created.length === 0 && c.updated.length === 0);
    check('4k/TOCTOU: the skip is recorded as a notice naming both SHAs',
      c.notices.some((n) => n.includes(SHA.slice(0, 12)) && n.includes(SHA2.slice(0, 12))));
  }
  {
    // head が動かない通常ケースは従来どおり（引き直しても同一 SHA なので投稿する）。
    const c = await run({ diff: digestBumpDiff, today: '2026-06-03', headShaSequence: [SHA, SHA] });
    check('4k/TOCTOU: an unchanged head still posts the status',
      c.statuses.length === 1 && c.statuses[0].state === 'pending' && c.statuses[0].sha === SHA);
  }

  // Test 4h (#13 戦略の PR 可視化): 適用された戦略（pure-bump / digest-centric）を
  // コメント本文に一言表示し、Actions ログを見なくても PR 上で判別できるようにする。
  {
    // 既定モード = pure-bump
    const c = await run({ diff: digestBumpDiff, today: '2026-06-03' });
    check('4h/#13: default-mode comment shows the pure-bump strategy',
      c.created.length === 1 && /Gating strategy: \*\*pure-bump\*\*/.test(c.created[0].body));
  }
  {
    // opt-in in-scope = digest-centric
    const c = await run({ diff: digestBumpDiff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4h/#13: opt-in comment shows the digest-centric strategy',
      c.created.length === 1 && /Gating strategy: \*\*digest-centric\*\*/.test(c.created[0].body));
  }

  // ── opt-in モード (gate-version-bumps=true): digest ベース判定 ──
  // 「+ 側に出てくる外部 docker digest のうち base（- 行＋context 行）に無いもの」
  // を gate する。tag 非依存の集合演算で、多重度・cross-file・境界スプーフに強く、
  // 新 digest を skip しない。既定の gate-authors=renovate[bot] を前提に、run() は
  // author=renovate[bot] を既定にしている。

  // Test 4-opt: 版更新（tag+digest 同時）= 新 digest なので gate。
  {
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM node:20@${DIG_OLD}`,
      `+FROM node:21@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt: version bump (new digest) gated when opted in',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    check('4-opt: comment shows the new tag',
      c.created.length === 1 && c.created[0].body.includes('node:21'));
  }

  // Test 4-opt-initialpin: 初回 pin も「新 digest」なので gate する（digest ベースの
  // 意図的な挙動。tag ベース旧実装では非 gate だった点が変わる）。
  {
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      '-FROM node:20',
      `+FROM node:20@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-initialpin: fresh/initial pin gated as a new digest',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
  }

  // Test 4-opt-reformat: 内容不変（reformat で -/+ に出るが digest 同一）は base に
  // 居るので非 gate。
  {
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM  node:20@${DIG_NEW}`,
      `+FROM node:20@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-reformat: unchanged digest (reformat) not gated',
      c.statuses.length === 0 && c.created.length === 0);
  }

  // Test 4-opt-multiplicity (logic HIGH 回帰): 同一ファイル内で同じ image:tag が
  // 「本物の版更新」と「reformat の未変更行」に重複しても、新 digest だけ gate し、
  // base に居る digest は非 gate（多重度マスキングの skip を防ぐ）。
  {
    const diff = [
      'diff --git a/docker-compose.yml b/docker-compose.yml',
      '--- a/docker-compose.yml',
      '+++ b/docker-compose.yml',
      '@@ -1,2 +1,2 @@',
      `-    image: node:18@${DIG_OLD}`,
      `+    image: node:20@${DIG_NEW}`,
      `-    image: node:18@${DIG_OLD}`,
      `+    image: node:18@${DIG_OLD}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-multiplicity: real bump gated despite a reformatted duplicate of the old tag',
      c.statuses.length === 1 && c.statuses[0].state === 'pending'
      && /1 external image digest/.test(c.statuses[0].description));
    check('4-opt-multiplicity: only the new digest is in the comment',
      c.created.length === 1
      && c.created[0].body.includes(DIG_NEW.slice(0, 19))
      && !c.created[0].body.includes(DIG_OLD.slice(0, 19)));
  }

  // Test 4-opt-crossfile (security HIGH 回帰): 版更新の -削除と +新タグ追加が別ファイル
  // に分かれていても、新 digest はどのファイルでも gate される（cross-file split の
  // skip を防ぐ）。
  {
    const diff = [
      'diff --git a/service-a.yaml b/service-a.yaml',
      '--- a/service-a.yaml',
      '+++ b/service-a.yaml',
      '@@ -1 +1 @@',
      `-image: node:20@${DIG_OLD}`,
      'diff --git a/service-b.yaml b/service-b.yaml',
      '--- a/service-b.yaml',
      '+++ b/service-b.yaml',
      '@@ -1 +1 @@',
      `+image: node:21@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-crossfile: new digest gated even when removal/addition are in different files',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
  }

  // Test 4-opt-basetrust: base に既にある digest（別ファイルの -行や context 行に
  // 出る）への付け替えは非 gate。base digest は投入時に gate 済み＝冷却済みなので信頼する。
  {
    const diff = [
      'diff --git a/k8s.yaml b/k8s.yaml',
      '--- a/k8s.yaml',
      '+++ b/k8s.yaml',
      '@@ -1 +1 @@',
      `-image: node@${DIG_NEW}`,
      'diff --git a/Dockerfile b/Dockerfile',
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      '@@ -1 +1 @@',
      `-FROM node:20@${DIG_OLD}`,
      `+FROM node:21@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-basetrust: re-pin to a digest already present in the base is not gated',
      c.statuses.length === 0 && c.created.length === 0);
  }

  // Test 4-opt-boundary: `----`（YAML 区切り削除）や `--- ...`/`+++ ...` 内容行が
  // -/+ の間に挟まっても、digest ベースは行内容による境界に一切依存しないので新 digest
  // を gate し続ける（境界スプーフ耐性）。diff --git ヘッダ無しでも成立。
  {
    const diff = [
      '--- a/k8s.yaml',
      '+++ b/k8s.yaml',
      `-image: node:20@${DIG_OLD}`,
      '----',
      '--- old block marker',
      '+++ new block marker',
      `+image: node:21@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-boundary: content-line boundary spoofs do not affect digest-centric gating',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
  }

  // Test 4-opt-metadata-spoof (security/tests CRITICAL 回帰): diff メタ行（`diff --git`
  // ヘッダ等）のファイルパスに `@sha256:<digest>` を仕込んでも baseDigests を汚染できず、
  // 本物の新 digest は gate される。メタ行のパスは PR 作者が制御するため信頼しない。
  {
    const diff = [
      `diff --git a/decoy@${DIG_NEW} b/decoy@${DIG_NEW}`,
      'new file mode 100644',
      'index 0000000..e69de29',
      'diff --git a/Dockerfile b/Dockerfile',
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      '@@ -1 +1 @@',
      `-FROM node:20@${DIG_OLD}`,
      `+FROM node:99@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-metadata-spoof: attacker filename `@digest` does not forge a base exemption',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
  }

  // Test 4-opt-plusplus-spoof (security/logic HIGH 回帰): a hunk *content*
  // line that renders as `+++ ...` (diff's own leading '+' plus original
  // content starting with `++ `) must still be read as an added digest --
  // classification is by structural position (inside the hunk, opened by
  // `@@ `), not by matching the literal `+++ ` text. At the same time a
  // *file-header* `--- ` line outside any hunk, even one crafted to carry
  // the very same digest, must never leak into `baseDigests` and forge an
  // "already in base" exemption.
  {
    const diff = [
      'diff --git a/Dockerfile b/Dockerfile',
      'index 0000000..1111111 100644',
      `--- a/x@${DIG_NEW}`,
      '+++ b/Dockerfile',
      '@@ -1,2 +1,2 @@',
      `-FROM node:20@${DIG_OLD}`,
      `+++ image: node:21@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-plusplus-spoof: hunk content line rendered as `+++ ` is gated despite a spoofed `--- ` header',
      c.statuses.length === 1 && c.statuses[0].state === 'pending'
      && c.created.length === 1 && c.created[0].body.includes(DIG_NEW.slice(0, 19)));
  }

  // Test 4-opt-context-base (tests HIGH 回帰): 既存 digest が unified diff の
  // context 行（先頭スペース1個、`@@` hunk 内・未変更行）にのみ出現する場合は
  // base 扱いで、それ自体は gate されない。同一ファイル内の別 image の新規
  // digest（`+` 行）は影響を受けず正しく gate される。
  {
    const CTX_DIGEST = 'sha256:' + '2'.repeat(64);
    const diff = [
      'diff --git a/k8s.yaml b/k8s.yaml',
      'index 0000000..1111111 100644',
      '--- a/k8s.yaml',
      '+++ b/k8s.yaml',
      '@@ -1,3 +1,3 @@',
      ` image: sidecar@${CTX_DIGEST}`,
      `-image: app:1.0@${DIG_OLD}`,
      `+image: app:2.0@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-context-base: unrelated new digest still gated alongside an unchanged context digest',
      c.statuses.length === 1 && c.statuses[0].state === 'pending'
      && c.created.length === 1
      && c.created[0].body.includes(DIG_NEW.slice(0, 19))
      && !c.created[0].body.includes(CTX_DIGEST.slice(0, 19)));
  }

  // Test 4-opt-context-suppress: context 行にのみ出現する既存 digest への
  // 付け替えは base 扱いなので非 gate（`-`/context のどちらも base として
  // 信頼される、という意味論を維持することを固定する）。
  {
    const diff = [
      'diff --git a/k8s.yaml b/k8s.yaml',
      'index 0000000..1111111 100644',
      '--- a/k8s.yaml',
      '+++ b/k8s.yaml',
      '@@ -1,3 +1,3 @@',
      ` image: sidecar@${DIG_NEW}`,
      `-image: app:1.0@${DIG_OLD}`,
      `+image: app:1.0@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-context-suppress: re-pin to a digest present only as a context line is not gated',
      c.statuses.length === 0 && c.created.length === 0);
  }

  // Test 4-opt-skip: opt-in でも skip-registries 該当は非 gate。
  {
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM ghcr.io/animalife/base:1@${DIG_OLD}`,
      `+FROM ghcr.io/animalife/base:2@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-skip: skip-listed registry not gated in opt-in mode',
      c.statuses.length === 0 && c.created.length === 0);
  }

  // Test 4-opt-author-skip: gate-authors=renovate[bot]（既定）で、対象外 author の
  // 版更新（新規 image）は digest-centric 戦略の対象外なので gate されない（人手 PR の
  // 過剰 gate 回避）。純粋 digest bump の baseline は別テスト 4-opt-author-baseline で担保。
  {
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM node:20@${DIG_OLD}`,
      `+FROM node:21@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', author: 'some-human',
      env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-author-skip: out-of-scope author version bump not gated (digest-centric scoped out)',
      c.statuses.length === 0 && c.created.length === 0);
  }

  // Test 4-opt-author-baseline (logic HIGH 回帰): opt-in + gate-authors=renovate[bot]
  // でも、対象外 author の「純粋 digest bump」は既定戦略で従来どおり gate される
  // （opt-in が既定より gate を減らさない＝author 絞りは fail-open しない）。
  {
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM node:20@${DIG_OLD}`,
      `+FROM node:20@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', author: 'some-human',
      env: { GATE_VERSION_BUMPS: 'true' } });
    check('4-opt-author-baseline: out-of-scope author still gets the pure-digest-bump baseline',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
  }

  // Test 4-opt-author-all: gate-authors 空なら author を問わず gate。
  {
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM node:20@${DIG_OLD}`,
      `+FROM node:21@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', author: 'some-human',
      env: { GATE_VERSION_BUMPS: 'true', GATE_AUTHORS: '' } });
    check('4-opt-author-all: empty gate-authors gates every author',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
  }

  // Test 5: digest 無関係の diff -> 何もしない
  {
    const diff = ['--- a/x', '+++ b/x', '-foo', '+bar'].join('\n');
    const c = await run({ diff, today: '2026-06-03' });
    check('5: unrelated diff ignored', c.statuses.length === 0 && c.created.length === 0);
  }

  // Test 6: 複数の *異なる* digest、片方だけ未経過 -> pending（最大残日数を報告）。
  // redis と nginx で別 digest を使い、集約パス（複数エントリの Math.max・複数行
  // render/sort）を実際に通す。redis(DIG_NEW) は 2 日前初観測で残 1d、nginx
  // (DIG_NEW2) は本日初観測で残 3d。報告は最大の 3d left でなければならない
  // （Math.max→Math.min の回帰なら 1d left になって落ちる）。
  {
    const DIG_NEW2 = 'sha256:' + '3'.repeat(64);
    const DIG_OLD2 = 'sha256:' + '4'.repeat(64);
    const diff = [
      '--- a/k8s.yaml',
      '+++ b/k8s.yaml',
      `-image: redis:7@${DIG_OLD}`,
      `+image: redis:7@${DIG_NEW}`,
      `-image: nginx:1@${DIG_OLD2}`,
      `+image: nginx:1@${DIG_NEW2}`,
    ].join('\n');
    const c = await run({
      diff,
      today: '2026-06-03',
      // redis(DIG_NEW) は 2 日前(残1d), nginx(DIG_NEW2) は本日初観測(残3d)
      comment: stateComment({ [DIG_NEW]: '2026-06-01' }),
    });
    check('6: pending while any digest immature', c.statuses[0].state === 'pending');
    check('6: aggregates and reports the MAX remaining days (3d, not 1d)',
      /3d left/.test(c.statuses[0].description) && /2 external image digest/.test(c.statuses[0].description));
    // 2 つの異なる digest が両方コメントに描画される（複数行 render/sort を通す）。
    const body6 = (c.updated[0] || c.created[0]).body;
    check('6: both distinct digests rendered in the comment',
      body6.includes(DIG_NEW.slice(0, 19)) && body6.includes(DIG_NEW2.slice(0, 19)));
  }

  // Test 7: base branch が gate 対象外(default branch 以外)の PR は、
  // digest bump を含んでいても skip される(release/main への昇格 PR 想定)。
  {
    const c = await run({
      diff: digestBumpDiff,
      today: '2026-06-03',
      base: 'release',
      defaultBranch: 'develop',
    });
    check('7: PR targeting non-gated base skipped', c.statuses.length === 0 && c.created.length === 0);
  }

  // Test 7b: base が default branch と一致する PR は gate される。
  {
    const c = await run({
      diff: digestBumpDiff,
      today: '2026-06-03',
      base: 'develop',
      defaultBranch: 'develop',
    });
    check('7b: PR targeting default branch gated', c.statuses.length === 1 && c.statuses[0].state === 'pending');
  }

  // Test 8: base-branches 入力で gate 対象を明示。指定外の base は skip。
  {
    const gated = await run({
      diff: digestBumpDiff,
      today: '2026-06-03',
      base: 'develop',
      defaultBranch: 'main',
      env: { BASE_BRANCHES: 'develop' },
    });
    check('8: explicit base-branches gates matching base', gated.statuses.length === 1);
    const skipped = await run({
      diff: digestBumpDiff,
      today: '2026-06-03',
      base: 'main',
      defaultBranch: 'main',
      env: { BASE_BRANCHES: 'develop' },
    });
    check('8: explicit base-branches skips non-matching base', skipped.statuses.length === 0 && skipped.created.length === 0);
  }

  // Test 9: always-report=true は digest を含まない PR にも success status を
  // 投稿する（required check 化の前提: 全 gated-base PR で context を reported に
  // する）。コメントは投稿しない。
  {
    const diff = ['--- a/x', '+++ b/x', '-foo', '+bar'].join('\n');
    const c = await run({ diff, today: '2026-06-03', env: { ALWAYS_REPORT: 'true' } });
    check('9: always-report posts success on digest-less PR',
      c.statuses.length === 1 && c.statuses[0].state === 'success' && c.statuses[0].sha === SHA);
    check('9: always-report posts no comment on digest-less PR', c.created.length === 0 && c.updated.length === 0);
  }

  // Test 9b: always-report=true でも gate 対象外 base（昇格 PR 想定）には
  // status を投稿しない（base フィルタがループ前に除外するため）。
  {
    const diff = ['--- a/x', '+++ b/x', '-foo', '+bar'].join('\n');
    const c = await run({
      diff, today: '2026-06-03', base: 'release', defaultBranch: 'develop',
      env: { ALWAYS_REPORT: 'true' },
    });
    check('9b: always-report does not report non-gated base', c.statuses.length === 0 && c.created.length === 0);
  }

  // Test 9c: always-report=true でも digest がある PR は通常どおり pending。
  {
    const c = await run({ diff: digestBumpDiff, today: '2026-06-03', env: { ALWAYS_REPORT: 'true' } });
    check('9c: always-report still gates a real digest bump',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
  }

  // Test 10 (security HIGH #1 回帰): 攻撃者が bot より先に back-date した state
  // コメントを投稿しても、findComment は作成者を検証するため無視される。新規
  // digest bump の冷却は偽装クリアされず pending のまま、bot は自分のコメントを
  // 新規作成する。
  {
    const attacker = {
      id: 42,
      user: { login: 'attacker' },
      body: `${MARKER}\nspoofed\n<!-- digest-cooldown-state ${JSON.stringify({ [DIG_NEW]: '2020-01-01' })} -->`,
    };
    const c = await run({ diff: digestBumpDiff, today: '2026-06-03', comment: attacker });
    check('10: back-dated state comment from an untrusted author is ignored (no forged clear)',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    check('10: bot ignores the attacker comment and creates its own state',
      c.created.length === 1 && c.updated.length === 0);
  }

  // Test 11 (#A 回帰): 信頼される作成者の正当なコメントでも、state 日付が不正
  // （"not-a-date"）なら NaN age で fail-open せず、TODAY にリセットして pending。
  {
    const c = await run({
      diff: digestBumpDiff,
      today: '2026-06-03',
      comment: stateComment({ [DIG_NEW]: 'not-a-date' }),
    });
    check('11: malformed stored date is re-stamped to TODAY, not trusted (no NaN fail-open)',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    // #5: 不正な first-seen date は握り潰さず warning で可視化する。
    check('11: malformed stored date emits a warning',
      c.warnings.some((w) => /malformed first-seen date/.test(w)));
  }

  // Test 12 (LOW #5 回帰): pr.user が欠落（削除済みユーザ等）していても crash せず、
  // author='' として扱われる。gate-version-bumps=true でも既定 gate-authors=
  // renovate[bot] に不一致なので digest-centric ではなく pure-digest-bump に
  // fail-safe fallback し、版更新（tag 変化・pure bump ではない）は gate されない。
  {
    const diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM node:20@${DIG_OLD}`,
      `+FROM node:21@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff, today: '2026-06-03', author: null,
      env: { GATE_VERSION_BUMPS: 'true' } });
    check('12: missing pr.user falls back to pure-digest-bump (version bump not gated)',
      c.statuses.length === 0 && c.created.length === 0);
  }

  // Test 13 (#2 観測性): degraded-to-baseline warning は *scan run*（PR_NUMBER 空で
  // 全 open PR を走査）のときだけ出す。単発 PR 実行（pull_request イベント）では、
  // 対象外 author の人手 PR が正しく baseline へフォールバックしただけなので warning は
  // 出さない（毎 PR ノイズ化を防ぐ）。scan run で in-scope author が 1 件も無ければ
  // それが本物の gate-authors 不一致シグナル。
  //
  // scan run 用の PR オブジェクトは pulls.list（=openPrs）から来る。author も list 側の
  // user.login で決まるため、openPrs に login を持たせる。
  const scanPr = (login) => ({
    number: 1, base: { ref: 'main' }, head: { sha: SHA }, user: { login },
  });
  {
    // scan run + author scope 外 -> digest-centric 未適用 -> warning 発火
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      env: { GATE_VERSION_BUMPS: 'true', PR_NUMBER: '' },
      openPrs: [scanPr('some-human')], defaultBranch: 'main',
    });
    check('13: scan-run gate-authors mismatch emits a degraded-to-baseline warning',
      c.warnings.some((w) => /digest-centric applied to no PR/.test(w)));
  }
  {
    // scan run + author scope 内(既定 renovate[bot]) -> digest-centric 適用 -> 非発火
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      env: { GATE_VERSION_BUMPS: 'true', PR_NUMBER: '' },
      openPrs: [scanPr('renovate[bot]')], defaultBranch: 'main',
    });
    check('13: no degraded-to-baseline warning when a scanned author is in scope',
      !c.warnings.some((w) => /digest-centric applied to no PR/.test(w)));
  }
  {
    // 単発 PR 実行（PR_NUMBER 指定、既定の '1'）では author が scope 外でも warning を
    // 出さない（人手 PR 1 件ごとの誤発火を抑制する #2 の眼目）。
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03', author: 'some-human',
      env: { GATE_VERSION_BUMPS: 'true' },
    });
    check('13: single-PR run stays quiet even when the author is out of scope',
      !c.warnings.some((w) => /digest-centric applied to no PR/.test(w)));
  }
  {
    // Test 15 境界 (#15): 0 PR の scan run（quiet repo の schedule 実行）では
    // prs.length===0 なので degraded warning を出さない（空走査での誤発火防止）。
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      env: { GATE_VERSION_BUMPS: 'true', PR_NUMBER: '' },
      openPrs: [], defaultBranch: 'main',
    });
    check('13/#15: zero-PR scan run emits no degraded-to-baseline warning',
      !c.warnings.some((w) => /digest-centric applied to no PR/.test(w))
      && c.statuses.length === 0);
  }

  // Test 14 (#3 trusted-comment-author カスタム値): TRUSTED_COMMENT_AUTHOR を
  // 上書きすると、そのカスタム作成者の back-date state コメントは信頼されて success に
  // 到達し、既定値(github-actions[bot])の作成者コメントは fail-closed で拒否され pending。
  {
    const custom = {
      id: 99,
      user: { login: 'my-bot[bot]' },
      body: `${MARKER}\nx\n<!-- digest-cooldown-state ${JSON.stringify({ [DIG_NEW]: '2026-06-01' })} -->`,
    };
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-04',
      comment: custom, env: { TRUSTED_COMMENT_AUTHOR: 'my-bot[bot]' },
    });
    check('14: custom trusted-comment-author is trusted (aged state clears to success)',
      c.statuses.length === 1 && c.statuses[0].state === 'success');
  }
  {
    // 同じカスタム設定下では既定値の作成者は信頼されず、コメントは無視されて
    // TODAY 初観測扱い -> pending（fail-closed）。untrusted 警告も出る。
    const defaultAuthor = {
      id: 99,
      user: BOT, // github-actions[bot]
      body: `${MARKER}\nx\n<!-- digest-cooldown-state ${JSON.stringify({ [DIG_NEW]: '2026-06-01' })} -->`,
    };
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-04',
      comment: defaultAuthor, env: { TRUSTED_COMMENT_AUTHOR: 'my-bot[bot]' },
    });
    check('14: default-author comment is rejected under a custom trusted author (fail-closed pending)',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    check('14: rejecting an untrusted state comment emits a warning',
      c.warnings.some((w) => /untrusted digest-cooldown state comment/.test(w)));
  }

  // Test 15 (resolveStrategy 純粋ユニット): 戦略選択ロジックを直接固定。
  // gate-version-bumps=false は常に false(pure-bump)、true は author が scope
  // 内のときだけ true。空 gate-authors は全 author を scope 内とする。
  {
    check('15/resolveStrategy: false mode is never digest-centric',
      resolveStrategy('renovate[bot]', false, []) === false);
    check('15/resolveStrategy: true + in-scope author is digest-centric',
      resolveStrategy('renovate[bot]', true, ['renovate[bot]']) === true);
    check('15/resolveStrategy: true + out-of-scope author falls back to baseline',
      resolveStrategy('some-human', true, ['renovate[bot]']) === false);
    check('15/resolveStrategy: empty gate-authors gates every author',
      resolveStrategy('some-human', true, []) === true);
  }

  // Test 16 (resolveBypass 純粋ユニット): 冷却バイパス判定を直接固定。未設定
  // （空文字）は常に null（機能オフ）、比較は case-insensitive、PR の複数 label
  // のうち 1 つ一致でマッチ、返り値は PR 側の原表記（設定側の表記ではなく）。
  {
    check('16/resolveBypass: empty bypass label is never a bypass',
      resolveBypass(['emergency'], '') === null);
    check('16/resolveBypass: exact match returns the label',
      resolveBypass(['emergency'], 'emergency') === 'emergency');
    check('16/resolveBypass: case-insensitive match (config Emergency vs label emergency)',
      resolveBypass(['emergency'], 'Emergency') === 'emergency');
    check('16/resolveBypass: one of several PR labels matches',
      resolveBypass(['wontfix', 'emergency', 'bug'], 'emergency') === 'emergency');
    check('16/resolveBypass: no match returns null',
      resolveBypass(['bug', 'chore'], 'emergency') === null);
    check('16/resolveBypass: return value is the PR-side original casing',
      resolveBypass(['Emergency-Merge'], 'emergency-merge') === 'Emergency-Merge');
  }

  // Test 17 (bypass 統合): gated digest あり + bypass label 一致 -> status success、
  // description に `bypassed via label`、state コメントは作成され first-seen=TODAY を
  // 記録（冷却タイマーはリセットしない）。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'], env: { BYPASS_LABEL: 'emergency' },
    });
    check('17a: bypass label forces success on a still-cooling digest',
      c.statuses.length === 1 && c.statuses[0].state === 'success');
    check('17a: success description mentions the bypass',
      /bypassed via label 'emergency'/.test(c.statuses[0].description));
    check('17a: state comment still created with first-seen=now (timer not reset)',
      c.created.length === 1
      && c.created[0].body.includes(`"${DIG_NEW}":"2026-06-03T00:00:00Z"`));
    check('17a: bypass is surfaced as an audit notice',
      c.notices.some((n) => /#1/.test(n) && /emergency/.test(n)));
  }

  // Test 17b: label はあるが BYPASS_LABEL 空（機能オフ）-> 従来どおり pending。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'], env: { BYPASS_LABEL: '' },
    });
    check('17b: label present but feature off (empty BYPASS_LABEL) stays pending',
      c.statuses.length === 1 && c.statuses[0].state === 'pending'
      && c.notices.length === 0);
  }

  // Test 17c: BYPASS_LABEL 設定済みだが PR に label 無し -> pending。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: [], env: { BYPASS_LABEL: 'emergency' },
    });
    check('17c: configured bypass label but PR has no label stays pending',
      c.statuses.length === 1 && c.statuses[0].state === 'pending'
      && c.notices.length === 0);
  }

  // Test 17d: 全 digest 冷却済み + bypass label あり -> success だが description は
  // 通常文言（実際に強制解除していないので bypassed とは書かない: 監査誤読防止）。
  {
    const state = { [DIG_NEW]: '2026-06-01' };
    const current = await renderBody(state, '2026-06-04', digestBumpDiff);
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-04',
      comment: { id: 99, user: BOT, body: current },
      labels: ['emergency'], env: { BYPASS_LABEL: 'emergency' },
    });
    check('17d: already-cooled digest with a bypass label is a normal success',
      c.statuses.length === 1 && c.statuses[0].state === 'success'
      && !/bypassed/.test(c.statuses[0].description));
  }

  // Test 17e: bypass label あり + gated digest 無し（always-report）-> 従来どおり
  // `no external image digest bumps to gate` の success（バイパス文言なし）。
  {
    const diff = ['--- a/x', '+++ b/x', '-foo', '+bar'].join('\n');
    const c = await run({
      diff, today: '2026-06-03',
      labels: ['emergency'], env: { BYPASS_LABEL: 'emergency', ALWAYS_REPORT: 'true' },
    });
    check('17e: bypass label with no gated digest is a plain always-report success',
      c.statuses.length === 1 && c.statuses[0].state === 'success'
      && /no external image digest bumps to gate/.test(c.statuses[0].description)
      && c.notices.length === 0);
  }

  // Test 17f: bypass 時のコメント本文に注記行が含まれ、bypass 無し時は含まれない。
  {
    const withBypass = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'], env: { BYPASS_LABEL: 'emergency' },
    });
    check('17f: bypass comment body carries the bypass note',
      withBypass.created.length === 1
      && /Cooldown bypass label `emergency` is attached/.test(withBypass.created[0].body));
    const withoutBypass = await run({ diff: digestBumpDiff, today: '2026-06-03' });
    check('17f: non-bypass comment body has no bypass note',
      withoutBypass.created.length === 1
      && !/Cooldown bypass label/.test(withoutBypass.created[0].body));
  }

  // Test 17g: BYPASS_LABEL のパース（前後空白トリム）を run() 経由で固定。
  // YAML 入力の空白混入があっても、case 違いの PR label にマッチする。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['Emergency'], env: { BYPASS_LABEL: '  emergency  ' },
    });
    check('17g: BYPASS_LABEL is trimmed and matched case-insensitively',
      c.statuses.length === 1 && c.statuses[0].state === 'success'
      && /bypassed via label 'Emergency'/.test(c.statuses[0].description));
  }

  // Test 18-export (公開面の回帰): REF / hunkContentLines は verify-image-provenance が
  // import して再利用している。export を外す・リネームするとここが落ちる（import 自体が
  // SyntaxError になる）ので、破壊を検知できる。tests/test-verify-image-provenance.mjs も
  // 併せて回すこと（あちらは実際の require 経路ごと契約を検証する）。
  {
    // REF は /g 付きなので、lastIndex を汚さない matchAll で使う（impl 側の注意書きと同じ）。
    const m = [...`FROM node:20@${DIG_NEW}`.matchAll(REF)];
    check('18-export/REF: matches image[:tag]@sha256:<hex> and captures name/digest',
      m.length === 1 && m[0][1] === 'node:20' && m[0][2] === DIG_NEW);
    // hunkContentLines は hunk 内の content 行（' ' / '+' / '-'）だけを返し、
    // `diff --git` 以降の file header 領域は `@@ ` が来るまで落とす。
    const lines = [...hunkContentLines([
      'diff --git a/x b/x',
      'index 0000000..1111111 100644',
      '--- a/x',
      '+++ b/x',
      '@@ -1,2 +1,2 @@',
      ' ctx',
      '-old',
      '+new',
    ].join('\n'))];
    check('18-export/hunkContentLines: yields only hunk content lines, skipping the file header',
      lines.length === 3
      && lines.map((l) => l.c).join('') === ' -+'
      && lines.map((l) => l.line).join('|') === ' ctx|-old|+new');
  }

  // Test 18-unit (resolveRequiredStatus 純粋ユニット): 与えられた候補 status から
  // 指定 context の state を引く。不在は null（= 未投稿）。run() は
  // latestStatusForContext で最新 1 件に絞ってから渡すが、複数渡されたときの
  // 合成規則（全件 success のときだけ success）も防御的に固定しておく。
  {
    check('18-unit/resolveRequiredStatus: matching context returns its state',
      resolveRequiredStatus([{ context: 'verify-image-provenance', state: 'success' }], 'verify-image-provenance') === 'success');
    check('18-unit/resolveRequiredStatus: absent context returns null',
      resolveRequiredStatus([{ context: 'other', state: 'success' }], 'verify-image-provenance') === null);
    check('18-unit/resolveRequiredStatus: picks only the requested context among several',
      resolveRequiredStatus([
        { context: 'lint', state: 'success' },
        { context: 'verify-image-provenance', state: 'failure' },
        { context: 'build', state: 'pending' },
      ], 'verify-image-provenance') === 'failure');
    // 同一 context が複数渡されたときは「全件 success のときだけ success」という
    // 順序非依存の fail-closed（配列順に依存しない）。run() の経路では
    // latestStatusForContext が最新 1 件に絞るのでこの合成は通常発生しない。
    check('18-unit/resolveRequiredStatus: duplicate contexts are only success when ALL are success',
      resolveRequiredStatus([
        { context: 'verify-image-provenance', state: 'failure' },
        { context: 'verify-image-provenance', state: 'success' },
      ], 'verify-image-provenance') === 'failure');
    // 順序非依存の証明: 先頭が success でも後方に非 success があれば success にしない
    // （旧「先頭 1 件」実装ならここで 'success' を返して fail-open していた）。
    check('18-unit/resolveRequiredStatus: a leading success does not mask a trailing failure (order-independent)',
      resolveRequiredStatus([
        { context: 'verify-image-provenance', state: 'success' },
        { context: 'verify-image-provenance', state: 'failure' },
      ], 'verify-image-provenance') === 'failure');
    check('18-unit/resolveRequiredStatus: duplicates that are all success resolve to success',
      resolveRequiredStatus([
        { context: 'verify-image-provenance', state: 'success' },
        { context: 'verify-image-provenance', state: 'success' },
      ], 'verify-image-provenance') === 'success');
    check('18-unit/resolveRequiredStatus: empty statuses returns null',
      resolveRequiredStatus([], 'verify-image-provenance') === null);
    check('18-unit/resolveRequiredStatus: non-array statuses returns null (defensive)',
      resolveRequiredStatus(undefined, 'verify-image-provenance') === null);

    // creator allowlist（trusted-comment-author と対称の防御）。
    const CREATORS = ['github-actions[bot]'];
    check('18-unit/resolveRequiredStatus: trusted creator keeps its state',
      resolveRequiredStatus([
        { context: 'verify-image-provenance', state: 'success', creator: { login: 'github-actions[bot]' } },
      ], 'verify-image-provenance', CREATORS) === 'success');
    check('18-unit/resolveRequiredStatus: untrusted creator is fail-closed as untrusted-creator',
      resolveRequiredStatus([
        { context: 'verify-image-provenance', state: 'success', creator: { login: 'attacker' } },
      ], 'verify-image-provenance', CREATORS) === 'untrusted-creator');
    check('18-unit/resolveRequiredStatus: a missing creator field is untrusted when an allowlist is set',
      resolveRequiredStatus([
        { context: 'verify-image-provenance', state: 'success' },
      ], 'verify-image-provenance', CREATORS) === 'untrusted-creator');
    check('18-unit/resolveRequiredStatus: creator comparison is case-insensitive',
      resolveRequiredStatus([
        { context: 'verify-image-provenance', state: 'success', creator: { login: 'GitHub-Actions[bot]' } },
      ], 'verify-image-provenance', CREATORS) === 'success');
    check('18-unit/resolveRequiredStatus: an empty allowlist skips creator verification (backward compatible)',
      resolveRequiredStatus([
        { context: 'verify-image-provenance', state: 'success', creator: { login: 'attacker' } },
      ], 'verify-image-provenance', []) === 'success'
      && resolveRequiredStatus([
        { context: 'verify-image-provenance', state: 'success', creator: { login: 'attacker' } },
      ], 'verify-image-provenance') === 'success');
    // untrusted な success が「全件 success」判定を汚染しないこと（fail-closed 合成）。
    check('18-unit/resolveRequiredStatus: an untrusted duplicate denies an otherwise-trusted success',
      resolveRequiredStatus([
        { context: 'verify-image-provenance', state: 'success', creator: { login: 'github-actions[bot]' } },
        { context: 'verify-image-provenance', state: 'success', creator: { login: 'attacker' } },
      ], 'verify-image-provenance', CREATORS) === 'untrusted-creator');
  }

  // Test 18-skip (isSkipRef / normalizeImageName の公開面と境界一致): verify 側の
  // ローカル実装を digest-cooldown の公開面へ移設したもの。素の startsWith だと
  // skip prefix `ghcr.io/animalife` が `ghcr.io/animalife-evil/x` にも一致し、
  // 似せた org 名のイメージを冷却ゲート外へ密輸できた（fail-open）。
  {
    const SKIP = ['ghcr.io/animalife'];
    check('18-skip/isSkipRef: own-org image is skipped',
      isSkipRef('ghcr.io/animalife/app', SKIP) === true);
    check('18-skip/isSkipRef: own-org image with a tag is skipped',
      isSkipRef('ghcr.io/animalife/base:1', SKIP) === true);
    check('18-skip/isSkipRef: the prefix itself is skipped (exact match)',
      isSkipRef('ghcr.io/animalife', SKIP) === true);
    check('18-skip/isSkipRef: a look-alike org is NOT skipped (segment boundary)',
      isSkipRef('ghcr.io/animalife-evil/pwned', SKIP) === false);
    check('18-skip/isSkipRef: a look-alike suffix is NOT skipped',
      isSkipRef('ghcr.io/animalifeX/y', SKIP) === false);
    check('18-skip/isSkipRef: docker.io is normalised away before matching',
      isSkipRef('docker.io/foo/bar:1', ['foo/bar']) === true);
    check('18-skip/isSkipRef: a trailing slash in the prefix means the same thing',
      isSkipRef('ghcr.io/animalife/app', ['ghcr.io/animalife/']) === true);
    check('18-skip/isSkipRef: an empty prefix list never skips',
      isSkipRef('ghcr.io/animalife/app', []) === false
      && isSkipRef('ghcr.io/animalife/app', ['', '  ']) === false);
    // round2 LOW-8: skip prefix 側も正規化する。以前は ref だけを正規化していたため
    // `foo/bar` という prefix は `docker.io/foo/bar` に一致するのに、`docker.io/foo`
    // という prefix は `foo/bar` に一致しない、という非対称があった（設定したのに
    // 効かない）。prefix も normalizeImageName に通して両向きに効かせる。
    check('18-skip/isSkipRef: a docker.io-qualified prefix matches a bare image name',
      isSkipRef('foo/bar', ['docker.io/foo']) === true
      && isSkipRef('foo/bar:1', ['index.docker.io/foo']) === true
      && isSkipRef('foo/bar', ['registry-1.docker.io/foo/bar']) === true);
    check('18-skip/isSkipRef: normalising the prefix keeps the segment boundary',
      isSkipRef('foo-evil/bar', ['docker.io/foo']) === false);
    check('18-skip/isSkipRef: a non-docker.io prefix is unaffected by the normalisation',
      isSkipRef('ghcr.io/animalife/app', ['ghcr.io/animalife']) === true
      && isSkipRef('evil-docker.io/foo/bar', ['foo']) === false);
    check('18-skip/isSkipRef: a registry:port prefix survives the normalisation (no tag strip)',
      isSkipRef('reg.example:5000/team/app:v1', ['reg.example:5000/team']) === true);
    // prefix 側は registry/name の**接頭辞**であって ref ではないので tag を持たない。
    // prefix にも normalizeImageName（= tag 落とし）を掛けていたとき、スラッシュを含まない
    // `reg.example:5000` の `:5000` が tag と誤認されて `reg.example` に縮み、**別ホスト**の
    // `reg.example/evil/x` まで skip する fail-open（= gate されない方向）になっていた。
    // registry エイリアス（docker.io/ 等）剥がしだけを prefix に適用する。
    check('18-skip/isSkipRef: a registry:port prefix does NOT skip the same host without the port',
      isSkipRef('reg.example/evil/x', ['reg.example:5000']) === false);
    check('18-skip/isSkipRef: a registry:port prefix still skips images under that port',
      isSkipRef('reg.example:5000/team/app', ['reg.example:5000']) === true
      && isSkipRef('reg.example:5000/team/app:v1', ['reg.example:5000']) === true);
    check('18-skip/normalizeImageName: drops the tag but keeps a registry:port host',
      normalizeImageName('reg.example:5000/team/app:v1') === 'reg.example:5000/team/app');
    check('18-skip/normalizeImageName: strips the implicit docker.io registry aliases',
      normalizeImageName('docker.io/foo/bar') === 'foo/bar'
      && normalizeImageName('index.docker.io/foo/bar') === 'foo/bar'
      && normalizeImageName('registry-1.docker.io/foo/bar') === 'foo/bar');
  }

  // Test 18-ref (REF の registry:port 対応): name 部にホスト直後の port を許す。
  // 拡張前は `reg.example:5000/team/app:v1` からホストが脱落して `5000/team/app:v1`
  // が抽出され、skip-registries にも provenance ポリシーにも永久に一致しなかった。
  {
    const D = 'sha256:' + '3'.repeat(64);
    const m = [...`+FROM reg.example:5000/team/app:v1@${D}`.matchAll(REF)];
    check('18-ref/REF: keeps the registry:port host in the extracted name',
      m.length === 1 && m[0][1] === 'reg.example:5000/team/app:v1' && m[0][2] === D);
    const l = [...`+FROM localhost:5000/x@${D}`.matchAll(REF)];
    check('18-ref/REF: keeps a port on a single-label host',
      l.length === 1 && l[0][1] === 'localhost:5000/x');
    // 回帰: tag だけの ref（port ではない `:`）は従来どおりの抽出結果のまま。
    const t = [...`+FROM node:20@${D}`.matchAll(REF)];
    check('18-ref/REF: a plain image:tag ref is unchanged by the port extension',
      t.length === 1 && t[0][1] === 'node:20');
    // registry:port 形式が end-to-end で skip-registries に一致する（抽出→判定）。
    check('18-ref: a registry:port ref extracted from a diff matches its skip prefix',
      isSkipRef(m[0][1], ['reg.example:5000/team']) === true);
  }

  // Test 18-ref-lhs (REF のマッチ開始位置): `${VAR}` 展開の直後に置かれた ref。
  //
  // `+FROM ${MIRROR}ghcr.io/animalife/base@sha256:...` は、実際には
  // `evil.example.com/ghcr.io/animalife/base@sha256:...` を pull する。`}` は name の
  // 文字クラス外なので、対策前の REF はそこからマッチを開始して name を
  // `ghcr.io/animalife/base` に切り落とし、既定 skip-registries に一致させていた
  // （＝冷却ゲートも provenance 検証も丸ごと素通り。今回塞いだ `startsWith` の
  // 密輸と同種の穴がマッチ開始位置に残っていた）。
  //
  // 対策は「`${...}` 展開クロージャを name の先頭に吸収する」こと。要件は 2 つで、
  //   (1) digest は gated 集合に**残る**（負 lookbehind で ref 全体をマッチ不能に
  //       すると digest ごと消え、冷却も掛からない別の fail-open になる）
  //   (2) 吸収した name は `$` `{` `}` を含むので skip prefix にも provenance
  //       ポリシー表のキーにも**構造的に一致し得ない**（fail-closed）
  {
    const D = 'sha256:' + '4'.repeat(64);
    const line = `+FROM \${MIRROR}ghcr.io/animalife/base@${D}`;
    const m = [...line.matchAll(REF)];
    check('18-ref-lhs/REF: a `${VAR}` expansion is absorbed into the extracted name',
      m.length === 1 && m[0][1] === '${MIRROR}ghcr.io/animalife/base' && m[0][2] === D);
    check('18-ref-lhs/REF: the absorbed name can never match a skip prefix',
      isSkipRef(m[0][1], ['ghcr.io/animalife']) === false);
    // 入れ子・連結した展開でも「name の左端が素の登録名に見える」形にならないこと。
    const nested = [...`+FROM \${A\${B}}ghcr.io/animalife/base@${D}`.matchAll(REF)];
    check('18-ref-lhs/REF: a nested expansion still leaves the name unmatchable',
      nested.length === 1 && /[${}]/.test(nested[0][1])
      && isSkipRef(nested[0][1], ['ghcr.io/animalife']) === false
      && nested[0][2] === D);
    const chained = [...`+FROM \${A}\${B}ghcr.io/animalife/base@${D}`.matchAll(REF)];
    check('18-ref-lhs/REF: chained expansions are absorbed as one prefix',
      chained.length === 1 && chained[0][1] === '${A}${B}ghcr.io/animalife/base'
      && isSkipRef(chained[0][1], ['ghcr.io/animalife']) === false);
    // 回帰: `}` を含まない通常の ref は一切影響を受けない（golden 等価の根拠）。
    const plain = [...`+FROM ghcr.io/animalife/base:1@${D}`.matchAll(REF)];
    check('18-ref-lhs/REF: an ordinary ref is untouched by the expansion prefix',
      plain.length === 1 && plain[0][1] === 'ghcr.io/animalife/base:1'
      && isSkipRef(plain[0][1], ['ghcr.io/animalife']) === true);
    // 回帰: 空白で区切られていれば `}` は吸収されない（JSON/YAML の閉じ括弧など）。
    const spaced = [...`+  } node:20@${D}`.matchAll(REF)];
    check('18-ref-lhs/REF: a `}` separated by whitespace is not absorbed',
      spaced.length === 1 && spaced[0][1] === 'node:20');
  }

  // Test 18-ref-lhs-gate: 上の抽出結果が両 gating モードで実際に fail-closed に
  // なること（digest は gated に残り、skip されない）を run() 経由で固定する。
  {
    const D = 'sha256:' + '5'.repeat(64);
    const DOLD = 'sha256:' + '6'.repeat(64);
    const mirrored = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      '+ARG MIRROR=evil.example.com/',
      `-FROM \${MIRROR}ghcr.io/animalife/base@${DOLD}`,
      `+FROM \${MIRROR}ghcr.io/animalife/base@${D}`,
    ].join('\n');
    const def = await run({ diff: mirrored, today: '2026-06-03' });
    check('18-ref-lhs-gate: default mode gates a `${VAR}`-prefixed own-org-looking ref',
      def.statuses.length === 1 && def.statuses[0].state === 'pending'
      && def.created.length === 1 && def.created[0].body.includes(D.slice(0, 19)));
    const centric = await run({
      diff: mirrored, today: '2026-06-03',
      env: { GATE_VERSION_BUMPS: 'true' },
    });
    check('18-ref-lhs-gate: digest-centric mode gates it too',
      centric.statuses.length === 1 && centric.statuses[0].state === 'pending');
    // 対比: 同じ diff から `${MIRROR}` を外すと従来どおり skip される（status なし）。
    const bare = await run({
      diff: mirrored.split('${MIRROR}').join(''), today: '2026-06-03',
    });
    check('18-ref-lhs-gate: the same ref without the expansion is still skipped as own-org',
      bare.statuses.length === 0);
  }

  // ── Test 18 系 (bypass-requires-status): bypass label に「指定 context の
  // commit status が success」という前提を課す。前提を満たさなければ label が
  // 付いていてもバイパスは効かない（fail-closed）。
  const PROV = 'verify-image-provenance';

  // Test 18a: label 一致 + 前提 status が success -> 従来どおりバイパスが効く。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [st(PROV, 'success')],
    });
    check('18a: bypass applies when the required status is success',
      c.statuses.length === 1 && c.statuses[0].state === 'success'
      && /bypassed via label 'emergency'/.test(c.statuses[0].description));
    check('18a: bypass is surfaced as an audit notice',
      c.notices.some((n) => /bypassed via label 'emergency'/.test(n)));
    check('18a: the required status is looked up on the head sha',
      c.statusListCalls.length === 1 && c.statusListCalls[0].ref === SHA);
  }

  // Test 18b: 前提 context が未投稿（不在）-> バイパス不適用で pending。
  // description と notice に理由（missing）が残る。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [st('lint', 'success')],
    });
    check('18b: missing required status denies the bypass (stays pending)',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    check('18b: pending description records the ignored bypass and its reason',
      new RegExp(`\\(bypass ignored: '${PROV}' missing\\)`).test(c.statuses[0].description));
    // setStatus は description を 140 字で slice するため「長さ <= 140」は常に真の
    // トートロジー。意味のある主張は「cap で理由の文字列が切り落とされていない」
    // ことなので、末尾に理由まで含んだ形で残っているかを見る。
    check('18b: the ignored-bypass reason survives the 140-char status cap intact',
      c.statuses[0].description.endsWith(`(bypass ignored: '${PROV}' missing)`)
      && c.statuses[0].description.length <= 140);
    check('18b: denied bypass is surfaced as an audit notice',
      c.notices.some((n) => /bypass/.test(n) && /ignored/.test(n) && new RegExp(PROV).test(n)));
  }

  // Test 18c: 前提 status が failure / pending -> バイパス不適用、理由に state 名。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [st(PROV, 'failure')],
    });
    check('18c: failing required status denies the bypass',
      c.statuses.length === 1 && c.statuses[0].state === 'pending'
      && new RegExp(`\\(bypass ignored: '${PROV}' failure\\)`).test(c.statuses[0].description));
    const p = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [st(PROV, 'pending')],
    });
    check('18c: still-pending required status denies the bypass',
      p.statuses.length === 1 && p.statuses[0].state === 'pending'
      && new RegExp(`\\(bypass ignored: '${PROV}' pending\\)`).test(p.statuses[0].description));
    // state が空文字（想定外の応答）でも理由が空欄（`... 'ctx' )`）にならず missing に寄る。
    const e = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [st(PROV, '')],
    });
    // error state（status 投稿側の実行時エラー）も success ではないので不適用。
    const err = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [st(PROV, 'error')],
    });
    check('18c: errored required status denies the bypass',
      err.statuses.length === 1 && err.statuses[0].state === 'pending'
      && new RegExp(`\\(bypass ignored: '${PROV}' error\\)`).test(err.statuses[0].description));
    check('18c: an empty state falls back to the `missing` reason (no blank reason)',
      e.statuses[0].state === 'pending'
      && new RegExp(`\\(bypass ignored: '${PROV}' missing\\)`).test(e.statuses[0].description));
  }

  // Test 18d: BYPASS_REQUIRES_STATUS 空（既定）-> 従来挙動のまま success で、
  // 前提 status の API は呼ばない（無駄 API 抑止＝後方互換の証明）。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'], env: { BYPASS_LABEL: 'emergency' },
      commitStatuses: [st(PROV, 'failure')],
    });
    check('18d: empty bypass-requires-status keeps the historical bypass behaviour',
      c.statuses.length === 1 && c.statuses[0].state === 'success'
      && /bypassed via label 'emergency'/.test(c.statuses[0].description));
    check('18d: no status-list API call when the feature is off',
      c.statusListCalls.length === 0);
  }

  // Test 18e: label 無し + BYPASS_REQUIRES_STATUS 設定 -> pending のまま、
  // 前提 status の API は呼ばない（バイパス判定に無関係なので引く必要が無い）。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: [], env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [st(PROV, 'success')],
    });
    check('18e: no bypass label stays pending', c.statuses[0].state === 'pending');
    check('18e: no status-list API call without a bypass label',
      c.statusListCalls.length === 0);
    check('18e: pending description carries no bypass note',
      !/bypass/.test(c.statuses[0].description));
  }

  // Test 18f: 自己参照（BYPASS_REQUIRES_STATUS = 自分の context）は設定ミス。
  // 自分の status を前提にすると永久に success へ到達できない（deadlock）ので、
  // warning を出して fail-closed（バイパス不適用）にし、API も引かない。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: 'digest-cooldown' },
      commitStatuses: [st('digest-cooldown', 'success')],
    });
    check('18f: self-referencing required status emits a warning',
      c.warnings.some((w) => /bypass-requires-status/.test(w)));
    check('18f: self-referencing required status denies the bypass (fail-closed)',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    check('18f: self-reference is judged without an API call',
      c.statusListCalls.length === 0);
    // case 違いの自己参照も設定ミスとして同一視する（resolveBypass の
    // case-insensitive 比較と整合。取りこぼして API を引きに行くより fail-closed）。
    const ci = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: 'Digest-Cooldown' },
      commitStatuses: [st('Digest-Cooldown', 'success')],
    });
    check('18f: self-reference is detected case-insensitively',
      ci.warnings.some((w) => /bypass-requires-status/.test(w))
      && ci.statuses[0].state === 'pending'
      && ci.statusListCalls.length === 0);
  }

  // Test 18g: バイパスが不適用のとき、PR コメントに「バイパス中」の注記行を
  // 出さない（効いていない label を効いている風に描かない＝監査の誤読防止）。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [st('lint', 'success')],
    });
    check('18g: denied bypass renders no bypass note in the comment body',
      c.created.length === 1 && !/Cooldown bypass label/.test(c.created[0].body));
  }

  // Test 18h (comment 失敗隔離と同じ方針): 前提 status の照会が失敗（rate limit / 5xx）しても
  // 外側 catch に飛ばさず、バイパスを fail-closed で落としたうえで gate 本体の
  // setStatus に必ず到達する（status 未更新の握り潰し＝required check deadlock を防ぐ）。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      failStatusList: true,
    });
    check('18h: a status-list API failure still posts the gate status (no swallowed run)',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    check('18h: unreadable required status denies the bypass (fail-closed) and is surfaced',
      new RegExp(`\\(bypass ignored: '${PROV}' unreadable\\)`).test(c.statuses[0].description)
      && c.warnings.some((w) => /failed to read the commit statuses/.test(w)));
    check('18h: the per-PR outer handler did not swallow the run',
      !c.warnings.some((w) => /Failed to process PR/.test(w)));
  }

  // Test 18i: 応答形状が想定外（`data` を欠く）でも、読み取りの TypeError は
  // 外側 catch へ飛ばさず unreadable として fail-closed に落とし、gate 本体の
  // status は必ず投稿する（18h と同じ隔離を「例外」ではなく「壊れた応答」で固定）。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      malformedStatusList: true,
    });
    check('18i: a malformed status-list response is fail-closed, not swallowed',
      c.statuses.length === 1 && c.statuses[0].state === 'pending'
      && new RegExp(`\\(bypass ignored: '${PROV}' unreadable\\)`).test(c.statuses[0].description)
      && !c.warnings.some((w) => /Failed to process PR/.test(w)));
  }

  // Test 18j: Statuses API の per_page 既定は 30。status を多く持つ commit で対象
  // context が 2 ページ目に落ちると missing 誤判定（＝正しく success なのにバイパスが
  // 効かない）になるため、per_page=100 を明示したうえで paginate で全ページ読む。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [st(PROV, 'success')],
    });
    check('18j: commit statuses are fetched with per_page=100 (default 30 would drop contexts)',
      c.statusListCalls.length === 1 && c.statusListCalls[0].per_page === 100);
  }

  // Test 18k: 全 digest が冷却済みで status は通常の success になるケースでも、
  // 「label は貼られていたが前提 status を満たさず不適用だった」痕跡を notice に
  // 残す（監査痕跡は remaining の有無に依存しない）。status の結果は変えない。
  {
    const state = { [DIG_NEW]: '2026-06-01' };
    const current = await renderBody(state, '2026-06-04', digestBumpDiff);
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-04',
      comment: { id: 99, user: BOT, body: current },
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [st(PROV, 'failure')],
    });
    check('18k: already-cooled PR with a denied bypass is a normal success',
      c.statuses.length === 1 && c.statuses[0].state === 'success'
      && !/bypass/.test(c.statuses[0].description));
    check('18k: the denied bypass is still audited via notice when nothing was cooling',
      c.notices.some((n) => /ignored/.test(n) && new RegExp(PROV).test(n) && /failure/.test(n)));
  }

  // ── Test 18l 系 (bypass-requires-status-creators): 前提 status の投稿者も検証する。
  // commit status は statuses:write を持つ誰でも投稿できるので、context と state だけの
  // 照合では「bot が検証したことにした status」を自作されうる。findComment が state
  // コメントを trusted-comment-author で絞っているのと対称の防御。

  // Test 18l: allowlist に含まれる creator の success -> 従来どおりバイパスが効く。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: {
        BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV,
        BYPASS_REQUIRES_STATUS_CREATORS: BOT_LOGIN,
      },
      commitStatuses: [st(PROV, 'success', { creator: BOT_LOGIN })],
    });
    check('18l: a status from a trusted creator lets the bypass apply',
      c.statuses.length === 1 && c.statuses[0].state === 'success'
      && /bypassed via label 'emergency'/.test(c.statuses[0].description));
  }

  // Test 18m: allowlist 外の creator が投稿した success はバイパスを許さない。
  // 理由 `untrusted-creator` が status description と notice に残る。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: {
        BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV,
        BYPASS_REQUIRES_STATUS_CREATORS: BOT_LOGIN,
      },
      commitStatuses: [st(PROV, 'success', { creator: 'attacker' })],
    });
    check('18m: a success posted by an untrusted creator denies the bypass (fail-closed)',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    check('18m: the untrusted-creator reason is recorded on the status and as a notice',
      new RegExp(`\\(bypass ignored: '${PROV}' untrusted-creator\\)`).test(c.statuses[0].description)
      && c.notices.some((n) => /untrusted-creator/.test(n)));
    check('18m: the comment renders no bypass note for a denied bypass',
      c.created.length === 1 && !/Cooldown bypass label/.test(c.created[0].body));
  }

  // Test 18n: allowlist を空文字にすると creator を検証しない（明示的な無効化＝従来挙動）。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: {
        BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV,
        BYPASS_REQUIRES_STATUS_CREATORS: '',
      },
      commitStatuses: [st(PROV, 'success', { creator: 'anyone' })],
    });
    check('18n: an empty creator allowlist disables creator verification',
      c.statuses.length === 1 && c.statuses[0].state === 'success');
    // カンマ区切りの複数 creator と前後空白のトリムも固定する。
    const multi = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: {
        BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV,
        BYPASS_REQUIRES_STATUS_CREATORS: ` other-bot , ${BOT_LOGIN} `,
      },
      commitStatuses: [st(PROV, 'success', { creator: BOT_LOGIN })],
    });
    check('18n: a comma-separated creator allowlist is trimmed and matched per entry',
      multi.statuses[0].state === 'success');
  }

  // Test 18o (action.yml の既定値と env 配線): 既定は `github-actions[bot]`
  // （既定 GITHUB_TOKEN が status を投稿したときの主体）。docs / impl と action.yml が
  // ずれると「既定で creator 検証が効いていない」に静かに倒れるので実物で固定する。
  {
    const yml = readFileSync(ACTION_YML, 'utf8');
    check('18o: action.yml declares bypass-requires-status-creators defaulting to github-actions[bot]',
      /bypass-requires-status-creators:[\s\S]*?default: github-actions\[bot\]/.test(yml));
    check('18o: action.yml wires the input into BYPASS_REQUIRES_STATUS_CREATORS',
      yml.includes('BYPASS_REQUIRES_STATUS_CREATORS: ${{ inputs.bypass-requires-status-creators }}'));
    // ハーネスが action.yml の既定値を実際に読めていること（読めていなければ
    // 「出荷構成の再現」を謳う 18r が別の値で回ってしまう）。
    check('18o: the harness reads the shipped default straight out of action.yml',
      actionInputDefault('bypass-requires-status-creators') === BOT_LOGIN
      && actionInputDefault('trusted-comment-author') === BOT_LOGIN
      && actionInputDefault('cooldown-days') === '3'
      && actionInputDefault('bypass-label') === '');
  }

  // Test 18r (出荷構成の再現): creators を env で **上書きせず**、action.yml の既定値
  // （`github-actions[bot]`）のまま、実 API 形状（list endpoint・creator あり）の
  // success がバイパスを許すこと。
  //
  // これが本 PR の HIGH 回帰テスト。以前の実装は Combined Status API
  // （`GET /commits/{sha}/status`）を引いていたが、その応答の `statuses[]` には
  // **`creator` が存在しない**。よって既定の非空 allowlist の下では login が常に空文字と
  // なり、すべての status が `untrusted-creator` に落ちて、出荷既定のままでは
  // bypass-requires-status が**永久に効かない**（機能が既定で死んでいる）。
  // creator を返す list endpoint（`GET /commits/{sha}/statuses`）に切り替えて初めて通る。
  {
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      // creators は指定しない = action.yml の既定値がそのまま効く
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [st(PROV, 'success')],
    });
    check('18r: the shipped default creator allowlist still lets a bot-posted success bypass',
      c.statuses.length === 1 && c.statuses[0].state === 'success'
      && /bypassed via label 'emergency'/.test(c.statuses[0].description));
    check('18r: the status is read from the list endpoint on the head sha',
      c.statusListCalls.length === 1 && c.statusListCalls[0].ref === SHA);
    // 対比: creator フィールドごと欠落した応答（= combined status の形）は、
    // 既定 allowlist の下では untrusted-creator として fail-closed に落ちる。
    const noCreator = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [st(PROV, 'success', { creator: null })],
    });
    check('18r: a status without a creator field is untrusted under the shipped default',
      noCreator.statuses[0].state === 'pending'
      && new RegExp(`\\(bypass ignored: '${PROV}' untrusted-creator\\)`).test(noCreator.statuses[0].description));
  }

  // Test 18s (list endpoint の履歴): list は同一 context の status を**履歴ごと全部**
  // 返す（combined と違い 1 件に集約しない）。実測では新しい順だが、順序に依存せず
  // updated_at 降順で最新 1 件だけを採ること。素朴に「全件 success のときだけ success」を
  // 履歴全体へ適用すると、過去の `pending` が永久に否決して機能が死ぬ。
  {
    const history = [
      st(PROV, 'success', { updatedAt: '2026-06-03T02:55:20Z' }),
      st(PROV, 'pending', { updatedAt: '2026-06-03T01:32:28Z' }),
      st(PROV, 'pending', { updatedAt: '2026-06-02T18:52:40Z' }),
    ];
    const c = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: history,
    });
    check('18s: an older pending in the status history does not veto the latest success',
      c.statuses.length === 1 && c.statuses[0].state === 'success'
      && /bypassed via label 'emergency'/.test(c.statuses[0].description));
    // 逆向き: 最新が failure なら、履歴に success があってもバイパスは効かない。
    const reverted = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [
        st(PROV, 'failure', { updatedAt: '2026-06-03T03:00:00Z' }),
        st(PROV, 'success', { updatedAt: '2026-06-03T02:55:20Z' }),
      ],
    });
    check('18s: an older success does not resurrect a newer failure',
      reverted.statuses[0].state === 'pending'
      && new RegExp(`\\(bypass ignored: '${PROV}' failure\\)`).test(reverted.statuses[0].description));
    // 配列順が古→新でも（API の並び順に依存しない）同じ判定になること。
    const ascending = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [...history].reverse(),
    });
    check('18s: the verdict does not depend on the array order returned by the API',
      ascending.statuses[0].state === 'success');
    // 履歴中の最新が untrusted creator の投稿なら、古い trusted success では通らない。
    const hijacked = await run({
      diff: digestBumpDiff, today: '2026-06-03',
      labels: ['emergency'],
      env: { BYPASS_LABEL: 'emergency', BYPASS_REQUIRES_STATUS: PROV },
      commitStatuses: [
        st(PROV, 'success', { creator: 'attacker', updatedAt: '2026-06-03T04:00:00Z' }),
        st(PROV, 'success', { updatedAt: '2026-06-03T02:55:20Z' }),
      ],
    });
    check('18s: the latest entry is what gets creator-verified (an untrusted newest denies)',
      hijacked.statuses[0].state === 'pending'
      && new RegExp(`\\(bypass ignored: '${PROV}' untrusted-creator\\)`).test(hijacked.statuses[0].description));
  }

  // Test 18t (latestStatusForContext 純粋ユニット): context 一致 + updated_at 降順で
  // 最新 1 件。実測では list は新→古で返るが、無根拠な順序依存を作らないため明示的に
  // 降順ソートしてから採る。
  {
    const a = { context: PROV, state: 'pending', updated_at: '2026-06-01T00:00:00Z' };
    const b = { context: PROV, state: 'success', updated_at: '2026-06-02T00:00:00Z' };
    const other = { context: 'lint', state: 'failure', updated_at: '2026-06-09T00:00:00Z' };
    check('18t/latestStatusForContext: picks the newest entry of the requested context',
      latestStatusForContext([a, b, other], PROV) === b
      && latestStatusForContext([b, a, other], PROV) === b);
    check('18t/latestStatusForContext: ignores other contexts entirely',
      latestStatusForContext([other], PROV) === null);
    check('18t/latestStatusForContext: an absent context is null (= not posted)',
      latestStatusForContext([], PROV) === null);
    check('18t/latestStatusForContext: a non-array input is null (defensive)',
      latestStatusForContext(undefined, PROV) === null
      && latestStatusForContext(null, PROV) === null);
    // updated_at を欠く/壊れた応答でも例外にせず、配列順（list は新→古）にフォールバック。
    const n1 = { context: PROV, state: 'failure' };
    const n2 = { context: PROV, state: 'success' };
    check('18t/latestStatusForContext: falls back to array order when updated_at is unusable',
      latestStatusForContext([n1, n2], PROV) === n1
      && latestStatusForContext([{ context: PROV, state: 'x', updated_at: 'not-a-date' }, n2], PROV).state === 'x');
    // updated_at を持つ 1 件と持たない 1 件が混ざったら、持っている方を新しいとみなす。
    check('18t/latestStatusForContext: a dated entry outranks an undated one',
      latestStatusForContext([n1, b], PROV) === b);
    check('18t/latestStatusForContext: null entries in the array are skipped',
      latestStatusForContext([null, undefined, b], PROV) === b);
  }

  // Test 18p (skip-registries の境界一致を run() 経由で固定): 似せた org 名
  // `ghcr.io/animalife-evil` は skip されず、通常どおり冷却の対象になる。
  // 素の startsWith 実装では skip されて冷却ゲートを完全に素通りしていた（fail-open）。
  {
    const evil = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM ghcr.io/animalife-evil/pwned:1@${DIG_OLD}`,
      `+FROM ghcr.io/animalife-evil/pwned:1@${DIG_NEW}`,
    ].join('\n');
    const c = await run({ diff: evil, today: '2026-06-03' });
    check('18p: a look-alike org is gated, not skipped as own-org',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    // 対比: 本物の自社 org は従来どおり skip される（status を出さない）。
    const own = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      `-FROM ghcr.io/animalife/app:1@${DIG_OLD}`,
      `+FROM ghcr.io/animalife/app:1@${DIG_NEW}`,
    ].join('\n');
    const o = await run({ diff: own, today: '2026-06-03' });
    check('18p: the genuine own-org image is still skipped',
      o.statuses.length === 0);
  }

  // Test 18q (diff 応答が非文字列): `mediaType` が効かず PR の JSON が返る等で
  // data が文字列でないとき、空 diff に潰して「gate 対象なし」と縮退させない。
  // always-report と組み合わさると success を投稿してしまう silent な fail-open に
  // なるため、warning を出して pending（fail-closed）に倒す。
  {
    const c = await run({ diff: { number: 1, head: { sha: SHA } }, today: '2026-06-03' });
    check('18q: a non-string diff response is fail-closed as pending',
      c.statuses.length === 1 && c.statuses[0].state === 'pending'
      && /unable to read the PR diff/.test(c.statuses[0].description));
    check('18q: the degraded diff response is surfaced as a warning',
      c.warnings.some((w) => /unexpected diff response type 'object'/.test(w)));
    check('18q: no state comment is written when the diff could not be read',
      c.created.length === 0 && c.updated.length === 0);
    const ar = await run({
      diff: { number: 1 }, today: '2026-06-03', env: { ALWAYS_REPORT: 'true' },
    });
    check('18q: always-report does NOT turn an unreadable diff into success',
      ar.statuses.length === 1 && ar.statuses[0].state === 'pending');
  }

  // parseDiff の直接ユニット。統合テストは run 経由でブリッジ→impl.mjs を通すが、
  // ここは impl.mjs を直接 import し、依存注入した isSkip で集合演算そのものを
  // 最小入力で固定する（純粋関数として振る舞いを明示）。
  {
    const skip = (n) => n.startsWith('ghcr.io/animalife');
    const D1 = 'sha256:' + '0'.repeat(64);
    const D2 = 'sha256:' + '1'.repeat(64);

    // 既定モード(false): 同一 image:tag の digest 変化のみ gate
    check('unit/default: pure digest bump gated',
      JSON.stringify(parseDiff(`-i: app:1.0@${D1}\n+i: app:1.0@${D2}`, false, skip).gated) === JSON.stringify({ [D2]: 'app:1.0' }));
    check('unit/default: tag bump not gated',
      Object.keys(parseDiff(`-i: app:1.0@${D1}\n+i: app:1.1@${D2}`, false, skip).gated).length === 0);
    check('unit/default: skip-listed not gated',
      Object.keys(parseDiff(`-i: ghcr.io/animalife/x:1@${D1}\n+i: ghcr.io/animalife/x:1@${D2}`, false, skip).gated).length === 0);
    // #6 回帰: 除去行が `--` で始まり `---i: ...` にレンダリングされても、default
    // は文字列一致ではなく hunk 構造で判定するため header と誤認しない。
    check('unit/default: pure digest bump gated even when the removed line renders as `---...`',
      JSON.stringify(parseDiff(`---i: app:1.0@${D1}\n+i: app:1.0@${D2}`, false, skip).gated) === JSON.stringify({ [D2]: 'app:1.0' }));

    // opt-in(true): base に無い新規 digest を tag 非依存で gate
    check('unit/opt: version bump (new digest) gated',
      JSON.stringify(parseDiff(`-i: app:1.0@${D1}\n+i: app:1.1@${D2}`, true, skip).gated) === JSON.stringify({ [D2]: 'app:1.1' }));
    check('unit/opt: re-pin to a base digest not gated',
      Object.keys(parseDiff(`-i: app:1.0@${D1}\n+i: app:1.1@${D1}`, true, skip).gated).length === 0);
    check('unit/opt: metadata filename @digest does not forge base exemption',
      JSON.stringify(parseDiff(`diff --git a/x@${D2} b/x@${D2}\n@@ -1 +1 @@\n+i: app:1.0@${D2}`, true, skip).gated) === JSON.stringify({ [D2]: 'app:1.0' }));
    check('unit/opt: skip-listed not gated',
      Object.keys(parseDiff(`+i: ghcr.io/animalife/x:1@${D2}`, true, skip).gated).length === 0);

    // #1 回帰: hunk 内の `+++ ` 実コンテンツ行は added として拾い、hunk 外の
    // `--- `/`+++ ` ヘッダ行（digest を騙ったものでも）は base に混入しない。
    check('unit/opt: content line rendered as `+++ ` inside a hunk is added, not skipped as a header',
      JSON.stringify(parseDiff(
        `diff --git a/x b/x\n--- a/x@${D2}\n+++ b/x\n@@ -1 +1 @@\n+++ i: app:1.0@${D2}`,
        true, skip,
      ).gated) === JSON.stringify({ [D2]: 'app:1.0' }));

    // #2 回帰: context 行（先頭スペース）にのみ出現する digest は base 扱いで、
    // それ自体は gate されず、同居する新規 digest だけが gate される。
    {
      const D3 = 'sha256:' + '2'.repeat(64);
      check('unit/opt: context-line digest is base only; unrelated new digest still gated',
        JSON.stringify(parseDiff(
          `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n i: sidecar@${D1}\n-i: app:1.0@${D2}\n+i: app:2.0@${D3}`,
          true, skip,
        ).gated) === JSON.stringify({ [D3]: 'app:2.0' }));
    }
    check('unit/opt: re-pin to a context-only base digest is not gated',
      Object.keys(parseDiff(
        `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n i: sidecar@${D2}\n-i: app:1.0@${D1}\n+i: app:1.0@${D2}`,
        true, skip,
      ).gated).length === 0);

    // #1 base-trust 非対称ガードの回帰: base 側(`-`)に skip-listed ref、added
    // 側(`+`)に *非skip* ref で同一 digest D を持つとき、skip 経由の digest は
    // base-trust に漏れてはならない。skip-listed base は投入時に gate されて
    // いない（＝冷却されていない）ので、同一 digest の非skip 新規 ref を免除して
    // はいけない。impl.mjs の `if (!isSkip(m[1])) baseDigests.add(m[2])` を固定する。
    {
      const D = 'sha256:' + '5'.repeat(64);
      check('unit/opt/basetrust: skip-listed base ref does not exempt a same-digest non-skip new ref',
        JSON.stringify(parseDiff(
          `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-image: ghcr.io/animalife/x@${D}\n+image: external/y@${D}`,
          true, skip,
        ).gated) === JSON.stringify({ [D]: 'external/y' }));
      // 対比: base 側が *非skip* ref なら、その digest は投入時に gate 済みとして
      // 信頼され、同一 digest への付け替えは免除される（base-trust が正常に働く）。
      // つまり上の skip ガードが無ければ skip-listed base も同様に免除してしまう、
      // というのが #1 の実効性（ガードがこの漏れを塞いでいる）。
      check('unit/opt/basetrust: non-skip base ref DOES exempt a same-digest new ref (trust works)',
        Object.keys(parseDiff(
          `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-image: trusted/z@${D}\n+image: external/y@${D}`,
          true, skip,
        ).gated).length === 0);
    }

    // #5 同一 digest × 複数 image 名(digest-centric): 同一 digest D を持つ 2 つの
    // 異なる image 名がいずれも base に無いとき、gated[digest]=name の後勝ちで 1
    // エントリに収束する（digest 単位で正しく gate、bypass ではない）。後勝ちの
    // name は実装の走査順で決まり、added 配列は登場順なので svc-b が残る。
    {
      const D = 'sha256:' + '6'.repeat(64);
      check('unit/opt/multi-name: same digest via two image names collapses to one gated entry (last wins)',
        JSON.stringify(parseDiff(
          `diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -0,0 +1,2 @@\n+image: svc-a@${D}\n+image: svc-b@${D}`,
          true, skip,
        ).gated) === JSON.stringify({ [D]: 'svc-b' }));
    }

    // #4 byte 等価の golden 固定(git 非依存): 既定モード(false)の中核主張「旧実装と
    // byte 等価」を、代表的な現実 diff の期待出力をハードコードした golden として
    // committed に固定する。旧実装との一致は既に fuzz で確認済みなので、ここでは
    // その確定値を CI で安定に回すのが目的（外部依存・大規模 fuzz なし）。
    {
      const G1 = 'sha256:' + 'a'.repeat(64);
      const G2 = 'sha256:' + 'b'.repeat(64);
      const G3 = 'sha256:' + 'c'.repeat(64);
      const G4 = 'sha256:' + 'd'.repeat(64);
      const golden = [
        {
          name: 'pure digest bump -> gated',
          diff: `--- a/Dockerfile\n+++ b/Dockerfile\n-FROM node:20@${G1}\n+FROM node:20@${G2}`,
          expect: { [G2]: 'node:20' },
        },
        {
          name: 'tag bump -> not gated (native minimumReleaseAge の領分)',
          diff: `--- a/Dockerfile\n+++ b/Dockerfile\n-FROM node:20@${G1}\n+FROM node:21@${G2}`,
          expect: {},
        },
        {
          name: 'skip-listed registry -> not gated',
          diff: `--- a/Dockerfile\n+++ b/Dockerfile\n-FROM ghcr.io/animalife/base:1@${G1}\n+FROM ghcr.io/animalife/base:1@${G2}`,
          expect: {},
        },
        {
          name: 'reformat (同一 image:tag・同一 digest) -> not gated',
          diff: `--- a/Dockerfile\n+++ b/Dockerfile\n-FROM  node:20@${G1}\n+FROM node:20@${G1}`,
          expect: {},
        },
        {
          name: 'multi-file 純粋 digest bump -> 両方 gated',
          diff: [
            'diff --git a/A b/A', '--- a/A', '+++ b/A', '@@ -1 +1 @@',
            `-FROM redis:7@${G1}`, `+FROM redis:7@${G2}`,
            'diff --git a/B b/B', '--- a/B', '+++ b/B', '@@ -1 +1 @@',
            `-FROM nginx:1@${G3}`, `+FROM nginx:1@${G4}`,
          ].join('\n'),
          expect: { [G2]: 'redis:7', [G4]: 'nginx:1' },
        },
      ];
      for (const g of golden) {
        check(`unit/default/golden: ${g.name}`,
          JSON.stringify(parseDiff(g.diff, false, skip).gated) === JSON.stringify(g.expect));
      }
    }

    // #11 取りこぼし回帰(parseDiff 直接): 同一 image:tag に複数 digest / 末尾で旧 digest
    // 再掲があっても、既定モードは新 digest を取りこぼさず gate（name→Set 化）。旧 last-wins
    // なら newByTag[app:1.0]=D1 に潰れて {} だった。
    check('unit/default/#11: trailing re-list of the old digest does not mask the new bump',
      JSON.stringify(parseDiff(
        `-i: app:1.0@${D1}\n+i: app:1.0@${D2}\n+i: app:1.0@${D1}`, false, skip,
      ).gated) === JSON.stringify({ [D2]: 'app:1.0' }));
    // #19 default multiplicity: 本物の bump + reformat の重複でも新 digest だけ gate。
    check('unit/default/#19: reformatted duplicate of the old ref does not mask the new bump',
      JSON.stringify(parseDiff(
        `-i: node:20@${D1}\n+i: node:20@${D2}\n-i: node:20@${D1}\n+i: node:20@${D1}`, false, skip,
      ).gated) === JSON.stringify({ [D2]: 'node:20' }));
    // 初回 pin（base に tag 無し）は既定モードでは非 gate（native 領分）。Set 化後も維持。
    check('unit/default: initial pin (tag absent from base) not gated',
      Object.keys(parseDiff(`+i: app:1.0@${D2}`, false, skip).gated).length === 0);

    // #1 反例(⊇ 撤回): in-scope でも「opt-in の方が gate が減る」ことを既知挙動として固定する。
    // base に既存の digest D2（別 image の context 行に実在）への付け替え（同一 tag で D1→D2）は、
    // 既定では pure digest bump として gate されるが、digest-centric では base-trust により非 gate。
    // したがって opt-in ⊇ 既定 は成り立たず、正しい保証は「author scope 絞りが fail-open しない」だけ。
    {
      const ctxDiff = [
        'diff --git a/k8s.yaml b/k8s.yaml',
        '--- a/k8s.yaml',
        '+++ b/k8s.yaml',
        '@@ -1,2 +1,2 @@',
        ` i: sidecar:2.0@${D2}`,     // context: D2 が base に実在
        `-i: app:1.0@${D1}`,
        `+i: app:1.0@${D2}`,         // 同一 tag で D1->D2 の付け替え
      ].join('\n');
      check('unit/#1-counterexample: default gates the re-pin to a base digest (pure bump)',
        JSON.stringify(parseDiff(ctxDiff, false, skip).gated) === JSON.stringify({ [D2]: 'app:1.0' }));
      check('unit/#1-counterexample: opt-in does NOT gate it — opt-in can gate LESS than default',
        Object.keys(parseDiff(ctxDiff, true, skip).gated).length === 0);
    }
  }

  // #14 純粋 helper の直接 unit（parseDiff/resolveStrategy と同様、export した
  // isValidDate / ageDays / sortedState / sameBody / renderComment を最小入力で固定）。
  {
    // #4: 実在しない暦日（2/30・4/31）は Date.parse の正規化（Feb30→Mar02）で通っていた。
    // round-trip 一致チェックで弾く。NaN（月13等）も finite 判定で弾き、toISOString は
    // 短絡で未到達（Invalid Date で throw しない）。
    check('unit/isValidDate: real date accepted', isValidDate('2026-06-01') === true);
    check('unit/isValidDate: non-existent calendar day rejected (2026-02-30)', isValidDate('2026-02-30') === false);
    check('unit/isValidDate: 4/31 rejected', isValidDate('2026-04-31') === false);
    check('unit/isValidDate: month 13 rejected without throwing', isValidDate('2026-13-01') === false);
    check('unit/isValidDate: garbage string rejected', isValidDate('not-a-date') === false);
    check('unit/isValidDate: non-string rejected', isValidDate(20260601) === false);
    check('unit/ageDays: whole-day difference', ageDays('2026-06-01', '2026-06-04') === 3);
    check('unit/ageDays: same day is zero', ageDays('2026-06-01', '2026-06-01') === 0);
    check('unit/sortedState: keys sorted for byte-stable JSON',
      JSON.stringify(sortedState({ b: 1, a: 2 })) === JSON.stringify({ a: 2, b: 1 }));
    check('unit/sameBody: CRLF-insensitive equality', sameBody('a\r\nb', 'a\nb') === true);
    check('unit/sameBody: genuine difference detected', sameBody('a', 'b') === false);
    {
      const D = 'sha256:' + '7'.repeat(64);
      const longName = 'x'.repeat(200);
      const body = renderComment({ [D]: '2026-06-01' }, { [D]: longName }, 3, '2026-06-01', 'pure-bump');
      check('unit/renderComment: truncates a long image name (display only)',
        body.includes('…') && !body.includes('x'.repeat(200)) && body.includes('x'.repeat(120)));
      check('unit/renderComment: state JSON keys on the digest, unaffected by name truncation',
        body.includes(`"${D}":"2026-06-01"`));
      check('unit/renderComment: surfaces the strategy label',
        body.includes('Gating strategy: **pure-bump**'));
      check('unit/renderComment: countdown reflects cooldownDays and today',
        renderComment({ [D]: '2026-06-01' }, { [D]: 'x' }, 3, '2026-06-01', 'pure-bump').includes('3d left')
        && renderComment({ [D]: '2026-06-01' }, { [D]: 'x' }, 3, '2026-06-04', 'pure-bump').includes('✅ ready'));
    }
  }

  // --- home fork: instant-precision cooldown ---------------------------------
  // A calendar-day comparison clears a 3-day gate after 2 days + 1 minute
  // (first seen 23:59Z -> age 1 at the next UTC midnight). These pin the
  // 72-hour semantics, including the legacy YYYY-MM-DD read path.
  {
    const seen = '2026-06-01T23:00:00Z';
    const justShort = await run({
      diff: digestBumpDiff, today: '2026-06-04',
      env: { NOW: '2026-06-04T22:59:00Z' },
      comment: stateComment({ [DIG_NEW]: seen }),
    });
    check('fork-1: 71h59m into a 3d cooldown is still pending (day-granularity would have cleared it)',
      justShort.statuses.length === 1 && justShort.statuses[0].state === 'pending');
    const exact = await run({
      diff: digestBumpDiff, today: '2026-06-04',
      env: { NOW: '2026-06-04T23:00:00Z' },
      comment: stateComment({ [DIG_NEW]: seen }),
    });
    check('fork-1: exactly 72h clears the cooldown',
      exact.statuses.length === 1 && exact.statuses[0].state === 'success');
    const legacy = await run({
      diff: digestBumpDiff, today: '2026-06-04',
      env: { NOW: '2026-06-04T00:00:00Z' },
      comment: stateComment({ [DIG_NEW]: '2026-06-01' }),
    });
    check('fork-1: a legacy YYYY-MM-DD first-seen is read as midnight UTC (back-compat)',
      legacy.statuses.length === 1 && legacy.statuses[0].state === 'success');
    const fresh = await run({
      diff: digestBumpDiff, today: '2026-06-03', env: { NOW: '2026-06-03T09:30:00Z' },
    });
    check('fork-1: a new observation is stamped with a full instant',
      fresh.created.length === 1
      && fresh.created[0].body.includes(`"${DIG_NEW}":"2026-06-03T09:30:00Z"`));
    check('fork-1: the comment table still shows the calendar day only',
      fresh.created[0].body.includes('| 2026-06-03 |'));

    check('unit/isValidInstant: accepts a bare date', isValidInstant('2026-06-01') === true);
    check('unit/isValidInstant: accepts an instant', isValidInstant('2026-06-01T23:00:00Z') === true);
    check('unit/isValidInstant: rejects a local-time string', isValidInstant('2026-06-01T23:00:00') === false);
    check('unit/isValidInstant: rejects garbage', isValidInstant('not-a-date') === false);
    check('unit/elapsedHours: instant difference', elapsedHours('2026-06-01T23:00:00Z', '2026-06-04T22:00:00Z') === 71);
    check('unit/remainingHours: floors at zero', remainingHours('2026-06-01', '2026-06-10', 3) === 0);
    check('unit/remainingHours: partial day remains', remainingHours('2026-06-01T23:00:00Z', '2026-06-04T22:00:00Z', 3) === 1);
  }

  // --- home fork: unknown digest algorithms are unjudgeable, not absent ------
  // REF only understands sha256, so any other OCI algorithm matched nothing and
  // — with always-report — was reported as "no digest bumps to gate" (success).
  {
    const sha512Diff = [
      '--- a/Dockerfile',
      '+++ b/Dockerfile',
      '-FROM node:20@sha512:' + 'a'.repeat(128),
      '+FROM node:20@sha512:' + 'b'.repeat(128),
    ].join('\n');
    const c = await run({ diff: sha512Diff, today: '2026-06-03' });
    check('fork-2: an unknown digest algorithm falls back to a fail-closed pending',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    check('fork-2: the unsupported algorithm is surfaced as a warning',
      c.warnings.some((w) => /unsupported digest algorithm 'sha512'/.test(w)));
    const withAlwaysReport = await run({
      diff: sha512Diff, today: '2026-06-03', env: { ALWAYS_REPORT: 'true' },
    });
    check('fork-2: always-report does not turn it into success (the fail-open this closes)',
      withAlwaysReport.statuses.length === 1 && withAlwaysReport.statuses[0].state === 'pending');

    let threw = false;
    try { assertKnownDigestAlgos(`FROM node:20@sha256:${'a'.repeat(64)}`); } catch { threw = true; }
    check('unit/assertKnownDigestAlgos: sha256 passes', threw === false);
    threw = false;
    try { assertKnownDigestAlgos(`FROM node:20@sha512:${'a'.repeat(128)}`); } catch { threw = true; }
    check('unit/assertKnownDigestAlgos: sha512 throws', threw === true);
    threw = false;
    try { assertKnownDigestAlgos('see user@example.com or ref@deadbeef'); } catch { threw = true; }
    check('unit/assertKnownDigestAlgos: a short hex run is not a digest', threw === false);
    threw = false;
    try { assertKnownDigestAlgos(`x@${'z'.repeat(4096)}`); } catch { threw = true; }
    check('unit/assertKnownDigestAlgos: a long non-digest line is scanned without throwing', threw === false);
  }

  // --- home fork: 1 行に収まっていない ref（分割形式）の名前解決 -------------
  //
  // issue #21: kustomize の `images:` や Helm values の `image.repository`/`tag` は
  // ref の構成要素を複数フィールドに分けるので、digest が載る行に registry が無い。
  // 従来はその行から抽出される name が **tag**（`latest`）になり、skip-registries が
  // 一致しようがなかった＝設定に書いた意味が消えていた。ここでは「同じマッピング
  // ブロックの名前キーから解決される」ことと、**解決の境界**（別項目・別ブロック・
  // 別 hunk・別ファイル・`${...}` 展開）を越えないことの両方を固定する。
  // 境界が緩むと、skip 側に倒れる = 冷却ゲートを素通りする fail-open になる。
  {
    const skip = (n) => n === 'registry.infra.tgy.io' || n.startsWith('registry.infra.tgy.io/');
    const D1 = 'sha256:' + 'a'.repeat(64);
    const D2 = 'sha256:' + 'b'.repeat(64);
    const D3 = 'sha256:' + 'c'.repeat(64);
    const D6 = 'sha256:' + 'f'.repeat(64);
    const gate = (diff, dc) => parseDiff(diff, dc, skip).gated;
    const notes = (diff, dc) => {
      const { unresolved } = parseDiff(diff, dc, skip);
      return Object.entries(unresolved).map(([dig, token]) => `${token}@${dig}`);
    };

    // 実物（home-cluster kustomize/taskflow/kustomization.yaml）の形。
    const kustomize = `diff --git a/k.yaml b/k.yaml
--- a/k.yaml
+++ b/k.yaml
@@ -37,4 +37,4 @@ resources:
 images:
   - name: controller
     newName: registry.infra.tgy.io/tools/taskflow
-    newTag: latest@${D1}
+    newTag: latest@${D2}`;
    for (const dc of [false, true]) {
      check(`unit/split: kustomize newName supplies the registry (digestCentric=${dc})`,
        Object.keys(gate(kustomize, dc)).length === 0);
    }
    // Helm values 形式。名前キーが tag の前でも後ろでも同じブロックなら解決する。
    check('unit/split: helm repository before tag',
      Object.keys(gate(`@@ -1 +1 @@\n image:\n   repository: registry.infra.tgy.io/tools/x\n-  tag: v1@${D1}\n+  tag: v2@${D2}`, true)).length === 0);
    check('unit/split: helm repository after tag',
      Object.keys(gate(`@@ -1 +1 @@\n image:\n-  tag: v1@${D1}\n+  tag: v2@${D2}\n   repository: registry.infra.tgy.io/tools/x`, true)).length === 0);
    // 解決しても skip でなければ gate は残る。表示名も tag ではなく解決後の名前。
    check('unit/split: an external split ref is still gated, under its resolved name',
      JSON.stringify(gate(`@@ -1 +1 @@\n image:\n   repository: ghcr.io/other/x\n+  tag: v2@${D2}`, true))
        === JSON.stringify({ [D2]: 'ghcr.io/other/x' }));

    // --- 解決の境界（ここが緩むと skip 側に倒れて fail-open） ---
    // リスト項目をまたがない: 2 つ目の項目には newName が無く、`name` 単独では
    // 解決しない（B: weak キー撤去）ので、1 つ目の newName を拾うことも、`name` の
    // 値（`b`）で解決することもなく unresolved のまま raw トークンで gate される。
    check('unit/split: a sibling list item does not inherit the previous item name',
      JSON.stringify(gate(`@@ -1 +1 @@\n images:\n   - name: a\n     newName: registry.infra.tgy.io/tools/a\n     newTag: latest@${D1}\n   - name: b\n+    newTag: latest@${D3}`, true))
        === JSON.stringify({ [D3]: 'latest' }));
    check('unit/split: ...and is reported unresolved rather than silently resolved to `name`',
      JSON.stringify(notes(`@@ -1 +1 @@\n images:\n   - name: a\n     newName: registry.infra.tgy.io/tools/a\n     newTag: latest@${D1}\n   - name: b\n+    newTag: latest@${D3}`, true))
        === JSON.stringify([`latest@${D3}`]));
    // インデントが浅くなったら別ブロック。
    check('unit/split: a dedent ends the block',
      JSON.stringify(gate(`@@ -1 +1 @@\n a:\n   repository: registry.infra.tgy.io/tools/a\n   tag: v1@${D1}\n b:\n+  tag: v2@${D2}`, true))
        === JSON.stringify({ [D2]: 'v2' }));
    // hunk / ファイルをまたがない（hunk 内でしか「行が原ファイル上でも連続」が
    // 保証されず、ブロックの切れ目が diff に現れる保証も無いため）。
    check('unit/split: no association across hunks',
      JSON.stringify(gate(`@@ -1 +1 @@\n   repository: registry.infra.tgy.io/tools/a\n@@ -9 +9 @@\n+  tag: v2@${D2}`, true))
        === JSON.stringify({ [D2]: 'v2' }));
    check('unit/split: no association across files',
      JSON.stringify(gate(`diff --git a/x b/x\n@@ -1 +1 @@\n   repository: registry.infra.tgy.io/tools/a\ndiff --git a/y b/y\n@@ -1 +1 @@\n+  tag: v2@${D2}`, true))
        === JSON.stringify({ [D2]: 'v2' }));
    // `${...}` 展開を吸収した名前は差し替えない（吸収は skip 密輸を塞ぐための
    // fail-closed 設計そのもの。ここで兄弟キーの名前に置き換えると穴が再開通する）。
    check('unit/split: a ${...}-absorbed name is never replaced by a sibling name',
      JSON.stringify(gate(`@@ -1 +1 @@\n   repository: registry.infra.tgy.io/tools/a\n+  tag: \${MIRROR}latest@${D2}`, true))
        === JSON.stringify({ [D2]: '${MIRROR}latest' }));
    // 名前キー側に `${...}` があるときも採用しない（判定不能として gate に残す）。
    check('unit/split: a ${...} in the name field is not accepted as a name',
      JSON.stringify(gate(`@@ -1 +1 @@\n   repository: \${REG}/tools/a\n+  tag: latest@${D2}`, true))
        === JSON.stringify({ [D2]: 'latest' }));
    // tag キーでも、値が `/` を含む完全な ref ならそのまま扱う（差し替えない）。
    check('unit/split: a full ref on a tag key keeps its own name',
      JSON.stringify(gate(`@@ -1 +1 @@\n   repository: registry.infra.tgy.io/tools/a\n+  tag: ghcr.io/other/x@${D2}`, true))
        === JSON.stringify({ [D2]: 'ghcr.io/other/x' }));
    // newName が name に勝つ（実際に pull されるのは newName 側）。
    check('unit/split: newName wins over name',
      JSON.stringify(gate(`@@ -1 +1 @@\n   - name: registry.infra.tgy.io/tools/a\n+    newTag: v2@${D2}\n     newName: ghcr.io/other/x`, true))
        === JSON.stringify({ [D2]: 'ghcr.io/other/x' }));
    // base 側の分割形式も同じ解決を通す。skip-listed な base ref は base-trust に
    // 漏らさない（既存の非対称ガードと同じ理由）ので、同一 digest の非 skip 新規
    // ref は gate される。
    check('unit/split: a skip-listed split base ref does not seed base trust',
      JSON.stringify(gate(`@@ -1 +1 @@\n a:\n   newName: registry.infra.tgy.io/tools/a\n-  newTag: v1@${D1}\n+FROM ghcr.io/other/x@${D1}`, true))
        === JSON.stringify({ [D1]: 'ghcr.io/other/x' }));

    // --- 判定不能の可視化（黙って「外部イメージ」にしない） ---
    check('unit/split: an unresolved split ref is reported (digest-centric)',
      JSON.stringify(notes(`@@ -1 +1 @@\n+  tag: v2@${D2}`, true)) === JSON.stringify([`v2@${D2}`]));
    check('unit/split: an unresolved split ref is reported (pure-bump)',
      JSON.stringify(notes(`@@ -1 +1 @@\n-  tag: v1@${D1}\n+  tag: v1@${D2}`, false)) === JSON.stringify([`v1@${D2}`]));
    check('unit/split: a resolved ref is not reported',
      notes(kustomize, true).length === 0);
    // 報告するのは **gate すると決まった** digest だけ。走査時点で報告すると、
    // base と同一 digest で結局 gate されない ref まで警告に載る。
    check('unit/split: a non-gated unresolved ref is not reported',
      notes(`@@ -1 +1 @@\n-  tag: v1@${D1}\n+  tag: v2@${D1}`, true).length === 0);

    // 未踏経路の回帰: 後方パス（名前キーが tag より後ろ）× リスト項目境界 × base 側
    // （`-` 行）。item a / item b はいずれも newName が自分の tag より後ろにあるので
    // 後方パスでしか解決できない。item b が誤って item a の（skip-listed な）newName
    // を引き継ぐと、item b の base digest が skip 扱いになって base-trust の対象外に
    // 落ち（isSkip ガード）、同じ digest を非 skip 名で再導入する `+` 行が gate されて
    // しまう。正しく境界が効いていれば item b は自分の（非 skip な）newName に解決され、
    // base-trust が効いて gate されない。
    check('unit/split: backward pass respects list-item boundaries on the base (`-`) side',
      (() => {
        const D5 = 'sha256:' + 'e'.repeat(64);
        const diff = [
          ' images:',
          '   - name: a',
          `-    tag: v1@${D1}`,
          '     newName: registry.infra.tgy.io/tools/a',
          '   - name: b',
          `-    tag: v1@${D5}`,
          '     newName: ghcr.io/other/y',
          ' other:',
          `+  image: svc-new@${D5}`,
        ].join('\n');
        return Object.keys(gate(diff, true)).length === 0;
      })());

    // --- Round 1 レビュー回帰（A〜E） ---

    // A: tag スカラーの値レンジに完全に収まらない REF マッチは差し替え対象にしない。
    // 行末コメントに紛れ込んだ 2 本目の ref（`evilimage`）は tag 自身の値
    // （`v2@D2`）の外にあるので、素の raw 名のまま扱われる = skip 密輸できず gate
    // される。tag スカラー自身（`v2@D2`）は newName 経由で skip-listed に解決され、
    // gated には現れない。
    check('unit/split (A): a ref hidden in a tag line\'s trailing comment is not absorbed into the sibling name',
      JSON.stringify(gate(`@@ -1 +1 @@\n image:\n   newName: registry.infra.tgy.io/tools/app\n-  tag: v1@${D1}\n+  tag: v2@${D2}  # rollback: evilimage@${D3}`, true))
        === JSON.stringify({ [D3]: 'evilimage' }));

    // B: `newName` / `repository` が同じブロックに全く無い `- name: <skip 対象>` は
    // 解決不能。skip 対象の値であっても採用しない（採用すると skip 側に倒れる
    // fail-open に戻る）ので gate され、かつ判定不能として報告される。
    check('unit/split (B): `- name:` alone (no newName in the diff) does not resolve, even when the name looks skip-listed',
      JSON.stringify(gate(`@@ -1 +1 @@\n images:\n   - name: registry.infra.tgy.io/tools/app\n+    newTag: latest@${D2}`, true))
        === JSON.stringify({ [D2]: 'latest' }));
    check('unit/split (B): ...and is reported unresolved',
      JSON.stringify(notes(`@@ -1 +1 @@\n images:\n   - name: registry.infra.tgy.io/tools/app\n+    newTag: latest@${D2}`, true))
        === JSON.stringify([`latest@${D2}`]));

    // C: `registry:` + `repository:` + `tag:` の 3 分割は `repository` 単独では
    // 解決しない。`registry + '/' + repository` を合成すると、chart が実際には
    // `.registry` を読まない場合に密輸経路になる（本文コメント参照）ので、
    // 判定不能として gate + 報告する。
    check('unit/split (C): registry + repository + tag does not resolve repository alone',
      JSON.stringify(gate(`@@ -1 +1 @@\n image:\n   registry: registry.infra.tgy.io\n   repository: tools/app\n+  tag: v2@${D2}`, true))
        === JSON.stringify({ [D2]: 'v2' }));
    check('unit/split (C): ...and is reported unresolved',
      JSON.stringify(notes(`@@ -1 +1 @@\n image:\n   registry: registry.infra.tgy.io\n   repository: tools/app\n+  tag: v2@${D2}`, true))
        === JSON.stringify([`v2@${D2}`]));

    // C 回帰（Round 2）: `repository:` / `registry:` が tag 行を挟んで **反対側**に
    // あっても無効化が効くこと。invalidated をパス内で確定させてから OR すると、
    // forward は registry を、backward は repository を、互いに見ないまま false
    // 固定になり、skip-registries に一致する repository がそのまま信頼される
    // fail-open になっていた（gated={} / unresolved={} という無音の抜け）。
    // pure-bump は `-`/`+` 両方に同じ tag（`v1`）を置き、初回 pin 扱いで
    // gate 判定自体がスキップされないようにする。
    check('unit/split (C, direction A): repository before tag, registry after -> still gate + unresolved (pure-bump)',
      JSON.stringify(gate(`@@ -1 +1 @@\n image:\n   repository: registry.infra.tgy.io/tools/app\n-  tag: v1@${D1}\n+  tag: v1@${D6}\n   registry: evil.example.com`, false))
        === JSON.stringify({ [D6]: 'v1' })
      && JSON.stringify(notes(`@@ -1 +1 @@\n image:\n   repository: registry.infra.tgy.io/tools/app\n-  tag: v1@${D1}\n+  tag: v1@${D6}\n   registry: evil.example.com`, false))
        === JSON.stringify([`v1@${D6}`]));
    check('unit/split (C, direction A): ...same shape, digest-centric',
      JSON.stringify(gate(`@@ -1 +1 @@\n image:\n   repository: registry.infra.tgy.io/tools/app\n-  tag: v1@${D1}\n+  tag: v1@${D6}\n   registry: evil.example.com`, true))
        === JSON.stringify({ [D6]: 'v1' })
      && JSON.stringify(notes(`@@ -1 +1 @@\n image:\n   repository: registry.infra.tgy.io/tools/app\n-  tag: v1@${D1}\n+  tag: v1@${D6}\n   registry: evil.example.com`, true))
        === JSON.stringify([`v1@${D6}`]));
    check('unit/split (C, direction B): registry before tag, repository after -> still gate + unresolved (pure-bump)',
      JSON.stringify(gate(`@@ -1 +1 @@\n image:\n   registry: evil.example.com\n-  tag: v1@${D1}\n+  tag: v1@${D6}\n   repository: registry.infra.tgy.io/tools/app`, false))
        === JSON.stringify({ [D6]: 'v1' })
      && JSON.stringify(notes(`@@ -1 +1 @@\n image:\n   registry: evil.example.com\n-  tag: v1@${D1}\n+  tag: v1@${D6}\n   repository: registry.infra.tgy.io/tools/app`, false))
        === JSON.stringify([`v1@${D6}`]));
    check('unit/split (C, direction B): ...same shape, digest-centric',
      JSON.stringify(gate(`@@ -1 +1 @@\n image:\n   registry: evil.example.com\n-  tag: v1@${D1}\n+  tag: v1@${D6}\n   repository: registry.infra.tgy.io/tools/app`, true))
        === JSON.stringify({ [D6]: 'v1' })
      && JSON.stringify(notes(`@@ -1 +1 @@\n image:\n   registry: evil.example.com\n-  tag: v1@${D1}\n+  tag: v1@${D6}\n   repository: registry.infra.tgy.io/tools/app`, true))
        === JSON.stringify([`v1@${D6}`]));

    // C（リスト項目境界）: `images:` の `- ` ブロックの中で registry 無効化が働くこと、
    // かつ隣接項目へ漏れないこと。1 項目目は registry 無し（解決）、2 項目目は
    // registry 有り（無効化）。
    {
      const D7 = 'sha256:' + '0'.repeat(64);
      const listItems = [
        '@@ -1 +1 @@',
        ' images:',
        '   - repository: registry.infra.tgy.io/tools/ok',
        `+    tag: v1@${D2}`,
        '   - registry: evil.example.com',
        '     repository: registry.infra.tgy.io/tools/ok2',
        `+    tag: v2@${D7}`,
      ].join('\n');
      check('unit/split (C, list item): the first item (no registry:) resolves and is skip-listed -> not gated',
        gate(listItems, true)[D2] === undefined);
      check('unit/split (C, list item): the second item (registry: present) is invalidated -> gate + unresolved',
        JSON.stringify(gate(listItems, true)) === JSON.stringify({ [D7]: 'v2' })
          && JSON.stringify(notes(listItems, true)) === JSON.stringify([`v2@${D7}`]));
    }

    // D: pure-bump（既定モード）の bump 同一性判定（キー）は raw tag トークン
    // （main と同じ土俵、Round 2 で解決名混入をやめた）なので、split 形式でも
    // タグが変わるバージョン bump は gate されない（digest-centric の契約を
    // pure-bump へ黙って広げない）。同じ tag のままの digest bump は従来どおり
    // gate される（表示名は skip 判定に使う解決名）。
    check('unit/split (D): a split-form version bump is NOT gated in pure-bump mode',
      Object.keys(gate(`@@ -1 +1 @@\n image:\n   repository: ghcr.io/other/x\n-  tag: v1@${D1}\n+  tag: v2@${D2}`, false)).length === 0);
    check('unit/split (D): a split-form digest-only bump (same tag) IS gated in pure-bump mode',
      JSON.stringify(gate(`@@ -1 +1 @@\n image:\n   repository: ghcr.io/other/x\n-  tag: v1@${D1}\n+  tag: v1@${D3}`, false))
        === JSON.stringify({ [D3]: 'ghcr.io/other/x' }));

    // E: 同一 digest が「解決済み」ブロックと「未解決」ブロックの両方から新規導入
    // されるとき、gated[] と unresolved[] は必ず同じ（後勝ちの）エントリを反映する
    // — 出現順をどちらにしても、表の名前と footer の注記が食い違わない。
    {
      const D4 = 'sha256:' + 'd'.repeat(64);
      const unresolvedLast = `@@ -1 +1 @@\n a:\n   newName: ghcr.io/other/x\n+  newTag: latest@${D4}\n b:\n+  tag: latest@${D4}`;
      check('unit/split (E): unresolved wins last -> gated name and unresolved note agree',
        JSON.stringify(gate(unresolvedLast, true)) === JSON.stringify({ [D4]: 'latest' })
          && JSON.stringify(notes(unresolvedLast, true)) === JSON.stringify([`latest@${D4}`]));
      const resolvedLast = `@@ -1 +1 @@\n b:\n+  tag: latest@${D4}\n a:\n   newName: ghcr.io/other/x\n+  newTag: latest@${D4}`;
      check('unit/split (E): resolved wins last -> gated name is clean and unresolved carries no stale note',
        JSON.stringify(gate(resolvedLast, true)) === JSON.stringify({ [D4]: 'ghcr.io/other/x' })
          && notes(resolvedLast, true).length === 0);
    }

    // E（pure-bump 版）: digest-centric だけでなく既定モードでも、同じ raw tag
    // トークンを共有する「解決済み」ブロックと「未解決」ブロックの両方から同一
    // digest が新規導入されるとき、gated[] と unresolved[] は同じ（後勝ちの）
    // 出現を反映すること。pure-bump は既定モード（gate-authors スコープ外の全 PR
    // が通る）で digest-centric より高頻度に踏まれる経路なので、ここが未テストだと
    // pure-bump 側だけの一貫性回帰を検出できない。値は現行実装（raw tag トークンを
    // キーにする Round 2 の修正後）で実測し直したもの — 一致の主張そのもの
    // （unresolved に載る token は必ず gated の表示名と一致する／resolved 側が
    // 勝ったときは unresolved に何も残らない）も合わせて固定する。
    {
      const H1 = 'sha256:' + '1'.repeat(64);
      const H2 = 'sha256:' + '2'.repeat(64);
      const H = 'sha256:' + '9'.repeat(64);
      const unresolvedLastPB = `@@ -1 +1 @@\n a:\n   repository: ghcr.io/other/x\n-  tag: v1@${H1}\n+  tag: v1@${H}\n b:\n-  tag: v1@${H2}\n+  tag: v1@${H}`;
      const gatedUL = gate(unresolvedLastPB, false);
      const notesUL = notes(unresolvedLastPB, false);
      check('unit/split (E, pure-bump): unresolved wins last -> gated name and unresolved note agree',
        JSON.stringify(gatedUL) === JSON.stringify({ [H]: 'v1' })
          && JSON.stringify(notesUL) === JSON.stringify([`v1@${H}`])
          // 一致そのものの主張: 各 unresolved エントリの digest について、
          // その token は gated の表示名と食い違わない。
          && notesUL.every((entry) => {
            const at = entry.lastIndexOf('@');
            return gatedUL[entry.slice(at + 1)] === entry.slice(0, at);
          }));
      const resolvedLastPB = `@@ -1 +1 @@\n b:\n-  tag: v1@${H2}\n+  tag: v1@${H}\n a:\n   repository: ghcr.io/other/x\n-  tag: v1@${H1}\n+  tag: v1@${H}`;
      check('unit/split (E, pure-bump): resolved wins last -> gated name is clean and unresolved carries no stale note',
        JSON.stringify(gate(resolvedLastPB, false)) === JSON.stringify({ [H]: 'ghcr.io/other/x' })
          && notes(resolvedLastPB, false).length === 0);
    }

    // --- Round 2 レビュー回帰 ---

    // A（強化）: 内包判定ではなく**完全一致**。tag スカラーの値に余剰トークンが
    // あれば（タブ + `#`、カンマ区切り、引用符内の 2 本目、スペース区切り）、
    // 兄弟ブロックの信頼名（skip-listed）に吸収されず、両方の ref が raw のまま
    // 通常の ref として扱われて gate される。内包判定だとこれらは全部
    // `{gated:{}, unresolved:{}}`（skip-listed に丸ごと吸収）に潰れていた。
    {
      const E1 = 'sha256:' + '1'.repeat(64);
      const E2 = 'sha256:' + '2'.repeat(64);
      const E3 = 'sha256:' + '3'.repeat(64);
      const base = `@@ -1 +1 @@\n image:\n   newName: registry.infra.tgy.io/tools/app\n-  tag: v1@${E1}\n+  tag: `;
      check('unit/split (A, exact match): tab + `#` before a second ref -> gated, not absorbed',
        gate(`${base}v1@${E2}\t#evil@${E3}`, true)[E3] !== undefined);
      check('unit/split (A, exact match): comma-separated second ref -> gated, not absorbed',
        gate(`${base}v1@${E2},evil@${E3}`, true)[E3] !== undefined);
      check('unit/split (A, exact match): a second ref inside the quoted scalar -> gated, not absorbed',
        gate(`${base}"v1@${E2} evil@${E3}"`, true)[E3] !== undefined);
      // 正常形は従来どおり解決される（完全一致でも壊れないことの固定）。
      const normal = `@@ -1 +1 @@\n image:\n   newName: registry.infra.tgy.io/tools/app\n-  newTag: latest@${E1}\n+  newTag: latest@${E2}`;
      check('unit/split (A, exact match): a normal single-ref scalar still resolves via the sibling name',
        Object.keys(gate(normal, true)).length === 0);
      const normalQuoted = `@@ -1 +1 @@\n image:\n   newName: registry.infra.tgy.io/tools/app\n-  newTag: "latest@${E1}"\n+  newTag: "latest@${E2}"`;
      check('unit/split (A, exact match): a normal quoted single-ref scalar still resolves via the sibling name',
        Object.keys(gate(normalQuoted, true)).length === 0);
    }

    // D（差し替え）: pure-bump の bump 同一性判定（キー）は解決状態から独立した
    // raw tag トークン。名前行の削除・変更・追加のいずれでも、同じ tag のままの
    // digest bump は gate される（main と同じ土俵）。
    {
      const F1 = 'sha256:' + '4'.repeat(64);
      const F2 = 'sha256:' + '5'.repeat(64);
      check('unit/split (D, key independence): removing the name line does not un-gate a same-tag digest bump',
        gate(`@@ -1 +1 @@\n image:\n-  repository: registry.example.com/app\n-  tag: latest@${F1}\n+  tag: latest@${F2}`, false)[F2] !== undefined);
      check('unit/split (D, key independence): changing the name line to an unresolvable one does not un-gate it',
        gate(`@@ -1 +1 @@\n image:\n-  repository: registry.example.com/app\n+  repository: \${REG}/app\n-  tag: latest@${F1}\n+  tag: latest@${F2}`, false)[F2] !== undefined);
      check('unit/split (D, key independence): adding a name line where there was none does not un-gate it',
        gate(`@@ -1 +1 @@\n image:\n+  repository: registry.example.com/app\n-  tag: latest@${F1}\n+  tag: latest@${F2}`, false)[F2] !== undefined);
      // 同じ raw tag トークンを 2 つの無関係なブロックが使い、片方だけ skip 対象の
      // レジストリを指すとき、非 skip 側の digest は gate される（「全部 skip の
      // ときだけ skip」— 1 つでも非 skip があれば gate、の固定）。
      const G1 = 'sha256:' + '6'.repeat(64);
      const G2 = 'sha256:' + '7'.repeat(64);
      const G = 'sha256:' + '8'.repeat(64);
      const twoBlocks = [
        '@@ -1 +1 @@',
        ' a:',
        '   repository: registry.infra.tgy.io/tools/trusted',
        `-  tag: latest@${G1}`,
        `+  tag: latest@${G}`,
        ' b:',
        '   repository: ghcr.io/other/evil',
        `-  tag: latest@${G2}`,
        `+  tag: latest@${G}`,
      ].join('\n');
      check('unit/split (D, key independence): a shared raw tag token across a trusted and an untrusted block still gates',
        JSON.stringify(gate(twoBlocks, false)) === JSON.stringify({ [G]: 'ghcr.io/other/evil' }));

      // Round 3: 表示名（`info.name`）は必ず**非 skip の出現**から採る。skip 側の
      // 出現でも無条件に最後勝ちで上書きすると、gate 自体は正しく効くのに、PR
      // コメントの表には gate の原因でない信頼レジストリ側の名前が出る（出現順に
      // 依存する監査可能性の破れ）。twoBlocks（trusted が先・untrusted が後）は
      // たまたま最後勝ちでも正解と一致するため検出できないので、逆順を固定する。
      const twoBlocksReversed = [
        '@@ -1 +1 @@',
        ' a:',
        '   repository: ghcr.io/other/evil',
        `-  tag: latest@${G2}`,
        `+  tag: latest@${G}`,
        ' b:',
        '   repository: registry.infra.tgy.io/tools/trusted',
        `-  tag: latest@${G1}`,
        `+  tag: latest@${G}`,
      ].join('\n');
      check('unit/split (D, key independence): ...still shows the untrusted (gate-causing) name even when the trusted block comes last',
        JSON.stringify(gate(twoBlocksReversed, false)) === JSON.stringify({ [G]: 'ghcr.io/other/evil' }));

      // 同じ不変条件は「未解決ブロック」側にも及ぶ: trusted ブロックが先に出現し、
      // 解決不能なブロックが後に出現しても、表示名 / unresolved は non-skip な
      // 未解決の出現（raw tag トークン）から採られる。
      const G3 = 'sha256:' + '9'.repeat(64);
      const trustedThenUnresolved = [
        '@@ -1 +1 @@',
        ' a:',
        '   repository: registry.infra.tgy.io/tools/trusted',
        `-  tag: latest@${G1}`,
        `+  tag: latest@${G3}`,
        ' b:',
        `-  tag: latest@${G2}`,
        `+  tag: latest@${G3}`,
      ].join('\n');
      check('unit/split (D, key independence): a trusted block sharing a tag with an unresolved block still gates + reports unresolved',
        JSON.stringify(gate(trustedThenUnresolved, false)) === JSON.stringify({ [G3]: 'latest' })
          && JSON.stringify(notes(trustedThenUnresolved, false)) === JSON.stringify([`latest@${G3}`]));
    }

    // --- Round 3 レビュー回帰 ---

    // 1: `newName`（kustomize が読む）と `repository`（Helm が読む）が同じブロックに
    // 両方あり、値が食い違う（＝ diff の見た目だけでは実行系がどちらを読むか
    // 決まらない）とき、解決しない（gate + unresolved）。従来は後勝ちで
    // どちらか片方を無条件採用していたため、無視される方のキーで実効名を
    // 差し替えられる fail-open だった。
    {
      const I1 = 'sha256:' + '1'.repeat(64);
      const I2 = 'sha256:' + '2'.repeat(64);
      const diverge = `@@ -1 +1 @@\n image:\n   repository: ghcr.io/evil/x\n   newName: registry.infra.tgy.io/tools/app\n-  tag: v1@${I1}\n+  tag: v1@${I2}`;
      check('unit/split (1, name ambiguity): repository and newName disagree -> gate + unresolved instead of trusting either',
        JSON.stringify(gate(diverge, false)) === JSON.stringify({ [I2]: 'v1' })
          && JSON.stringify(notes(diverge, false)) === JSON.stringify([`v1@${I2}`]));
      // registry + repository + newName すべて同居: 名前の曖昧さと registry
      // 無効化のどちらの経路からも解決しないこと（2 例目、同時に閉じる）。
      const triple = `@@ -1 +1 @@\n image:\n   registry: evil.example.com\n   repository: evil/payload\n   newName: registry.infra.tgy.io/tools/app\n-  tag: v1@${I1}\n+  tag: v1@${I2}`;
      check('unit/split (1, name ambiguity): registry + repository + newName together -> still gate + unresolved',
        JSON.stringify(gate(triple, false)) === JSON.stringify({ [I2]: 'v1' })
          && JSON.stringify(notes(triple, false)) === JSON.stringify([`v1@${I2}`]));
      // 回帰ガード: `newName` と `repository` が**同じ値**を指すなら曖昧ではない
      // （distinct な候補は 1 つ）ので、従来どおり解決される。
      const agree = `@@ -1 +1 @@\n image:\n   repository: registry.infra.tgy.io/tools/app\n   newName: registry.infra.tgy.io/tools/app\n-  tag: v1@${I1}\n+  tag: v1@${I2}`;
      check('unit/split (1, name ambiguity): repository and newName agreeing on the same value still resolves',
        Object.keys(gate(agree, false)).length === 0);
    }

    // 2: CRLF 改行のリポでは KEY_LINE が一切マッチせず（JS の `.` は `\r` を除外、
    // `$` は `/m` 無しで入力の絶対末尾にしかマッチしない）、分割形式の解決が丸ごと
    // no-op になっていた。skip-registries が黙って効かなくなり、callout も出ない。
    {
      const J1 = 'sha256:' + '3'.repeat(64);
      const J2 = 'sha256:' + '4'.repeat(64);
      const crlf = [
        '@@ -1 +1 @@',
        ' image:',
        '   newName: registry.infra.tgy.io/tools/app',
        `-  tag: v1@${J1}`,
        `+  tag: v1@${J2}`,
      ].join('\r\n');
      check('unit/split (2, CRLF): a CRLF diff still resolves the split name and honours skip-registries',
        Object.keys(gate(crlf, false)).length === 0);
    }

    // 3: `blockNameFor` が「tag 行ではない」と「tag 行だがスパンが一致しなかった」を
    // どちらも `undefined` に潰していたため、Round 2 の完全一致化で解決から外れた
    // 分（YAML として正当だが `scalarValue` のコメット除去がタブ区切りを認識しない
    // 等）が、callout なしで黙って「通常の ref」として gate されていた。今は
    // `null`（= unresolved）を返すので gate は変わらないが可視化される。
    {
      const K1 = 'sha256:' + '5'.repeat(64);
      const K2 = 'sha256:' + '6'.repeat(64);
      const tabComment = `@@ -1 +1 @@\n image:\n   newName: registry.infra.tgy.io/tools/app\n-  tag: v1@${K1}\n+  tag: v1@${K2}\t# renovate`;
      check('unit/split (3, span mismatch visibility): a tab-separated trailing comment (no hidden ref) still reports unresolved',
        JSON.stringify(gate(tabComment, false)) === JSON.stringify({ [K2]: 'v1' })
          && JSON.stringify(notes(tabComment, false)) === JSON.stringify([`v1@${K2}`]));
      // 回帰ガード: 行末に何も無い正常な tag 行（Round 1 A のもともとの主張）は、
      // これまでどおり callout なしで解決される。
      const clean = `@@ -1 +1 @@\n image:\n   newName: registry.infra.tgy.io/tools/app\n-  tag: v1@${K1}\n+  tag: v1@${K2}`;
      check('unit/split (3, span mismatch visibility): a clean tag line is unaffected (no spurious unresolved)',
        Object.keys(gate(clean, false)).length === 0 && notes(clean, false).length === 0);
    }

    // 4: 分割形式では key が raw tag トークンのみ（registry を持たない）なので、
    // 同じ diff 内の**無関係な 2 つのイメージ**が同じ tag（`latest` 等）を共有
    // しうる。片方の正当な bump が `oldByTag` にそのキーを持ち込むと、もう片方の
    // 初回 pin が「base に既存のキー」判定を誤って通過し、gate されてしまっていた。
    {
      const L1 = 'sha256:' + '7'.repeat(64);
      const L2 = 'sha256:' + '8'.repeat(64);
      const L3 = 'sha256:' + '9'.repeat(64);
      const collision = [
        '@@ -1 +1 @@',
        ' images:',
        '   - name: a',
        '     newName: registry.infra.tgy.io/tools/imageA',
        `-    newTag: latest@${L1}`,
        `+    newTag: latest@${L2}`,
        '   - name: b',
        '     newName: ghcr.io/external/imageB',
        `+    newTag: latest@${L3}`,
      ].join('\n');
      check('unit/split (4, initial-pin precision): an unrelated image sharing a raw tag token with a genuine bump is not gated as that bump',
        gate(collision, false)[L3] === undefined);
      // 単独なら初回 pin として非 gate であることの対照実験（相互作用ではなく
      // imageB 自身の性質であることを切り分ける）。
      const alone = [
        '   - name: b',
        '     newName: ghcr.io/external/imageB',
        `+    newTag: latest@${L3}`,
      ].join('\n');
      check('unit/split (4, initial-pin precision): ...imageB alone is indeed an (un-gated) initial pin',
        gate(alone, false)[L3] === undefined);
      // sameImage の名前比較は normalizeImageName を通す（isSkipRef との対称性）。
      // `docker.io/` 別名だけが変わる本当に同一のイメージの bump が、生文字列
      // 比較だと「別イメージの初回 pin」に誤判定されて免除されてしまっていた。
      const M1 = 'sha256:' + 'c'.repeat(64);
      const M2 = 'sha256:' + 'd'.repeat(64);
      const dockerIoAlias = `@@ -1 +1 @@\n image:\n-  repository: docker.io/bitnami/nginx\n+  repository: bitnami/nginx\n-  tag: 1.25@${M1}\n+  tag: 1.25@${M2}`;
      check('unit/split (4, initial-pin precision): a same-tag digest bump across a docker.io/ alias is still gated',
        JSON.stringify(gate(dockerIoAlias, false)) === JSON.stringify({ [M2]: 'bitnami/nginx' }));
    }
  }

  // Test 21 (分割形式を run() 経由で): skip-registries が書式によらず効くこと、
  // 判定不能は gate しつつ PR コメントとログに出ること。
  {
    const D1 = 'sha256:' + 'a'.repeat(64);
    const D2 = 'sha256:' + 'b'.repeat(64);
    let c = await run({
      diff: `diff --git a/k.yaml b/k.yaml\n@@ -1 +1 @@\n image:\n   repository: ghcr.io/animalife/app\n-  tag: v1@${D1}\n+  tag: v1@${D2}`,
      today: '2026-06-03',
    });
    check('21: a split-form ref on a skip-listed registry is not gated',
      c.statuses.length === 0 && c.created.length === 0);

    c = await run({
      diff: `diff --git a/k.yaml b/k.yaml\n@@ -1 +1 @@\n-  tag: v1@${D1}\n+  tag: v1@${D2}`,
      today: '2026-06-03',
    });
    check('21: an unresolved split-form ref is still gated (fail-closed)',
      c.statuses.length === 1 && c.statuses[0].state === 'pending');
    check('21: the unresolved ref is called out in the PR comment',
      c.created.length === 1 && /split form/.test(c.created[0].body)
        && c.created[0].body.includes(D2.slice(0, 19)));
    check('21: the unresolved ref is surfaced as a warning',
      c.warnings.some((w) => /split form/.test(w)));
  }

  // --- merge_group: PR head の判定をマージキューの一時 commit に転記する ---
  {
    const MG_SHA = 'b'.repeat(40);
    const BASE_SHA = 'c'.repeat(40);
    const mg = (headRef = `refs/heads/gh-readonly-queue/main/pr-7-${BASE_SHA}`) => ({
      eventName: 'merge_group',
      sha: MG_SHA,
      payload: { merge_group: { head_sha: MG_SHA, head_ref: headRef, base_ref: 'refs/heads/main' } },
    });
    const only = (c) => c.statuses.length === 1 ? c.statuses[0] : null;

    let c = await run({ diff: '', today: '2026-06-03', contextExtra: mg(),
      commitStatuses: [st('digest-cooldown', 'success')] });
    let s1 = only(c);
    check('merge_group: PR head success is mirrored as success on the merge-group head',
      s1 && s1.sha === MG_SHA && s1.state === 'success' && s1.context === 'digest-cooldown');
    check('merge_group: the PR head statuses are read from the PR number in the queue ref',
      c.statusListCalls.length === 1 && c.statusListCalls[0].ref === SHA);
    check('merge_group: no comment is touched', c.created.length === 0 && c.updated.length === 0);

    c = await run({ diff: '', today: '2026-06-03', contextExtra: mg(),
      commitStatuses: [st('digest-cooldown', 'pending')] });
    s1 = only(c);
    check('merge_group: PR head pending stays pending on the merge-group head',
      s1 && s1.sha === MG_SHA && s1.state === 'pending');

    c = await run({ diff: '', today: '2026-06-03', contextExtra: mg(), commitStatuses: [] });
    s1 = only(c);
    check('merge_group: missing PR head status is fail-closed (pending)',
      s1 && s1.sha === MG_SHA && s1.state === 'pending' && /missing/.test(s1.description));

    c = await run({ diff: '', today: '2026-06-03', contextExtra: mg(),
      commitStatuses: [st('digest-cooldown', 'success', { creator: 'mallory' })] });
    s1 = only(c);
    check('merge_group: success posted by an untrusted creator is fail-closed (pending)',
      s1 && s1.state === 'pending' && /untrusted-creator/.test(s1.description));

    c = await run({ diff: '', today: '2026-06-03', contextExtra: mg(),
      commitStatuses: [st('digest-cooldown', 'pending', { updatedAt: '2026-06-01T00:00:00Z' }), st('digest-cooldown', 'success', { updatedAt: '2026-06-02T00:00:00Z' })] });
    s1 = only(c);
    check('merge_group: only the latest PR head status counts (older pending does not veto)',
      s1 && s1.state === 'success');

    c = await run({ diff: '', today: '2026-06-03', contextExtra: mg('refs/heads/gh-readonly-queue/main/not-a-queue-ref'),
      commitStatuses: [st('digest-cooldown', 'success')] });
    s1 = only(c);
    check('merge_group: an unparseable queue ref is fail-closed (pending)',
      s1 && s1.state === 'pending' && c.statusListCalls.length === 0);

    c = await run({ diff: '', today: '2026-06-03', contextExtra: mg(), failStatusList: true });
    s1 = only(c);
    check('merge_group: statuses API failure is fail-closed (pending)',
      s1 && s1.state === 'pending' && /failed to read/.test(s1.description));

    c = await run({ diff: '', today: '2026-06-03', contextExtra: mg(), failPullGet: true });
    s1 = only(c);
    check('merge_group: pulls API failure is fail-closed (pending)',
      s1 && s1.state === 'pending');

    c = await run({ diff: '', today: '2026-06-03', contextExtra: mg(),
      commitStatuses: [st('digest-cooldown', 'success')], env: { MERGE_GROUP_STATUS_CREATORS: '' } });
    s1 = only(c);
    check('merge_group: empty creators allowlist skips creator verification',
      s1 && s1.state === 'success');

    c = await run({ diff: '', today: '2026-06-03', contextExtra: mg(),
      commitStatuses: [st('digest-cooldown', 'success')], env: { DRY_RUN: 'true' } });
    check('merge_group: dry-run posts nothing', c.statuses.length === 0);
  }

  console.log('');
  if (failures > 0) {
    console.log(`${failures} test(s) failed`);
    process.exit(1);
  }
  console.log('All digest-cooldown tests passed');
};

main();
