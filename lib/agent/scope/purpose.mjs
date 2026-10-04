import { SCOPE_REJECTED_MESSAGE, ScopeError } from './errors.mjs';
import { isIssuedClassification } from './classify.mjs';

export const ADMISSION_SCHEMA = 'zuku.scope.admission/1';
export const REQUEST_MAX = 4000;
const issued = new WeakSet();
export const isIssuedAdmission = value => issued.has(value);

// Primary purposes that are not ZUKU/ZUKUJS game development. These reject even when the
// request also mentions games: adding the word "game" is not a bypass.
const HARD = Object.freeze([
  { id: 'ecommerce', pattern: /e-?commerce|online\s+(store|shop)|shopping\s+cart|checkout\s+(page|flow|system)|storefront|쇼핑몰|전자\s*상거래/u, hint: 'In a ZUKU game, model a shop as an in-game item store backed by game state.' },
  { id: 'accounting', pattern: /accounting|bookkeeping|payroll|invoic(e|ing)\s+(system|app|software|tool)|tax\s+(return|filing)|\berp\b|\bcrm\b|회계|장부|급여|세금\s*신고/u, hint: 'Game economies (currency, rewards) can be built as in-game systems.' },
  { id: 'saas', pattern: /\bsaas\b|\bb2b\s+(app|platform|tool)/u, hint: '' },
  { id: 'bot', pattern: /\b(discord|slack|telegram|whatsapp|twitter|line|kakao)\s*(bot|봇)\b|디스코드\s*봇|텔레그램\s*봇|슬랙\s*봇|챗봇|chat\s*bot/u, hint: 'Community or chat features can be built inside a ZUKU game using ZUKU APIs.' },
  { id: 'scraper', pattern: /scrap(e|er|ers|ing)\b|web\s*crawl|crawler|크롤러|크롤링|스크래핑/u, hint: '' },
  { id: 'website', pattern: /landing\s+page|portfolio\s+(site|website)|\bblog\b|\bcms\b|corporate\s+(site|website)|marketing\s+(site|website)|wordpress|website\s+builder|블로그|홈페이지/u, hint: '' },
  { id: 'trading', pattern: /(crypto(currency)?|stock)\s+trading|trading\s+bot|nft\s+mint(ing)?\s+(site|page)|주식\s*봇|코인\s*봇/u, hint: '' },
  { id: 'sysadmin', pattern: /\b(manage|administer|administrate|harden|configure)\b[^.]*\b(linux|server|vps|nginx|apache|docker|kubernetes|firewall)\b|sysadmin|server\s+administration|서버\s*관리/u, hint: '' },
  { id: 'general-agent', pattern: /claude\s*code|generic\s+(?:codex|shell|coding)|general[\s-]purpose\s+(coding|assistant|agent)|any\s+(project|codebase|repo(sitory)?)|unrestricted|ignore\s+(the\s+|your\s+|all\s+)?(previous|prior|scope|restrictions?|rules|instructions)|bypass|jailbreak|without\s+(any\s+)?restrictions|shell\s+access|범용\s*코딩|제한\s*없이/u, hint: '' },
]);
// Game networking/storage is in scope, but a generic service is not; needs concrete
// game-domain terms, not just the word "game".
const SOFT_BACKEND = /(back-?end|server|service|api)\b.*\b(service|server|api|microservice|crud)|rest\s*api|microservice|crud\s+app|admin\s+dashboard|백엔드|서버\s*만들/u;
const GAME_DOMAIN = /leaderboard|multiplayer|matchmaking|lobby|save\s*(game|data|slot)|game\s*state|netcode|realtime\s+(game|match)|zuku\s*(api|sdk)|리더보드|멀티\s*플레이|매치메이킹|세이브/u;

const GAME_TERMS = /\bgames?\b|게임|gameplay|player|\blevels?\b|sprite|\bscenes?\b|tilemap|physics|collision|shader|glsl|wgsl|\bwasm\b|webassembly|\bhud\b|\bscore|enemy|enemies|\bboss|\bnpc|inventory|\baudio|\bsound|music|animation|render|canvas|webgl|webgpu|\bfps\b|frame\s*rate|joystick|gamepad|controller|touch\s+input|multiplayer|leaderboard|playtest|캐릭터|레벨|점수|물리|충돌|셰이더|사운드|애니메이션|플레이어|스테이지|아이템|퍼즐|슈팅|러너|플랫포머|대시|점프/u;
const ECOSYSTEM_TERMS = /\bzuku(js)?\b|zwf|zuku\s*(api|sdk|runtime)|주쿠/u;
const MAINTENANCE = /\bfix|\bbug|error|\bbuild|\btests?\b|refactor|optimi[sz]e|performance|crash|\blint|type\s*error|typescript|upgrade|update|integrat|inspect|버그|오류|빌드|테스트|수정|최적화|리팩터|개선|고쳐|추가/u;
const CREATE = /\b(create|make|build|generate|start|new)\b[^.]*\bgames?\b|새\s*게임|게임[^.]*(만들|제작|생성)|만들어\s*줘/u;
const INIT = /\b(init|initiali[sz]e|scaffold|bootstrap|set\s*up)\b|초기화|프로젝트\s*(생성|설정)/u;
const MIGRATE = /\b(migrat|port(ing)?\b|convert)[^.]*\b(zuku(js)?|zwf)\b|\b(zuku(js)?)\b[^.]*\b(migrat|port|conver)|(주쿠|zuku(js)?)[^.]*(이전|이식|마이그레이션|포팅|변환)/u;

function freeze(value) { const result = Object.freeze({ schema: ADMISSION_SCHEMA, ...value }); issued.add(result); return result; }

/** Classifies only the user's own request text; returns the matched intent flags. */
export function analyzeRequest(request) {
  const text = String(request ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  return {
    text,
    hard: HARD.find(item => item.pattern.test(text)) ?? null,
    softBackend: SOFT_BACKEND.test(text) && !GAME_DOMAIN.test(text),
    game: GAME_TERMS.test(text) || GAME_DOMAIN.test(text),
    ecosystem: ECOSYSTEM_TERMS.test(text),
    maintenance: MAINTENANCE.test(text),
    create: CREATE.test(text), init: INIT.test(text), migrate: MIGRATE.test(text),
  };
}

/** Pure decision. Returns { route, intent, category, hint } with route 'new-game'|'scoped'|'reject'. */
export function decideGameRequest(request, classification, { forceCreate = false } = {}) {
  const reject = (category, hint = '') => ({ route: 'reject', intent: null, category, hint });
  if (request !== undefined && request !== null && typeof request !== 'string') return reject('invalid');
  if (typeof request === 'string' && (request.length > REQUEST_MAX || /[\x00-\x08\x0b-\x1f\x7f]/.test(request))) return reject('invalid');
  const intent = analyzeRequest(request);
  if (intent.hard) return reject(intent.hard.id, intent.hard.hint);
  if (intent.softBackend) return reject('backend', 'Game networking and storage belong in a ZUKU game through ZUKU APIs (leaderboards, saves, multiplayer).');
  const purposeful = intent.game || intent.ecosystem;
  const kind = classification.classification;
  const newGame = mode => ({ route: 'new-game', intent: mode, category: 'game', hint: '' });
  const scoped = mode => ({ route: 'scoped', intent: mode, category: 'game', hint: '' });
  if (kind === 'out-of-scope') return forceCreate && (purposeful || !intent.text) ? newGame('create') : reject('workspace');
  if (kind === 'unknown') {
    if (classification.empty) {
      if (!intent.text || forceCreate || intent.create || intent.init || intent.migrate || purposeful) return newGame(intent.migrate ? 'migrate' : intent.init ? 'init' : 'create');
      return reject('purpose');
    }
    if (intent.migrate) return scoped('migrate');
    if ((forceCreate || intent.create || intent.init) && (purposeful || !intent.text)) return newGame(intent.init ? 'init' : 'create');
    return reject('workspace');
  }
  // zuku / zukujs / zuku-compatible: an existing ecosystem project.
  if (forceCreate) return newGame('create');
  if (!intent.text) return reject('purpose');
  if (intent.migrate) return scoped('migrate');
  if (purposeful || intent.maintenance) return scoped('maintain');
  return reject('purpose');
}

/**
 * admitGameRequest(request, classification, { forceCreate }) -> frozen admission, or throws
 * ScopeError (code AGENT_REQUEST_OUT_OF_SCOPE, fixed message) when rejected.
 * Runs before any provider, model, token or network use. The classification must be the
 * host object from classifyWorkspace. Routes:
 *   'new-game' -> the existing runGameAgent pipeline
 *   'scoped'   -> runScopedGameAgent tool loop
 */
export function admitGameRequest(request, classification, { forceCreate = false } = {}) {
  if (!isIssuedClassification(classification)) throw new ScopeError('SCOPE_CLASSIFICATION_INVALID');
  const decision = decideGameRequest(request, classification, { forceCreate });
  if (decision.route === 'reject') throw new ScopeError('SCOPE_REJECTED', { category: decision.category, ...(decision.hint ? { hint: decision.hint } : {}) });
  return freeze({ admitted: true, route: decision.route, intent: decision.intent, category: decision.category, message: '', hint: '' });
}

/** Internal admission for direct host tool calls (project.read/patch/search, build/test). */
export function toolAdmission(classification) {
  if (!isIssuedClassification(classification)) throw new ScopeError('SCOPE_CLASSIFICATION_INVALID');
  if (classification.classification === 'out-of-scope') throw new ScopeError('SCOPE_REJECTED', { category: 'workspace' });
  return freeze({ admitted: true, route: 'scoped', intent: 'tools', category: 'game', message: '', hint: '' });
}
