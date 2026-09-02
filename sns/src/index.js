// パチつな（仮）MVP — 依存ゼロの単一 Cloudflare Worker
// 意図的な簡略化: 禁止語フィルタは文脈を見ない単純部分一致（MVP）。本格対応する場合は形態素解析＋文脈判定を入れる。

const TAGS = ["求人", "中古台", "新台情報", "店舗運営", "イベント告知", "雑談", "質問"];
const BANNED_WORDS = ["設定", "出玉", "還元", "勝てる", "甘い", "回収", "誇大"];
const MAX_BODY_LEN = 500;
const PAGE_SIZE = 20;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

function containsBannedWord(text) {
  return BANNED_WORDS.some((w) => text.includes(w));
}

async function sha256Hex(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getAuthedUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const match = auth.match(/^Bearer\s+(.+)$/);
  if (!match) return null;
  const token = match[1].trim();
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT id, handle, display_name, role, area FROM users WHERE token_hash = ?"
  )
    .bind(tokenHash)
    .first();
  return row || null;
}

function isValidHandle(handle) {
  return typeof handle === "string" && /^[a-zA-Z0-9_]{2,20}$/.test(handle);
}

const VALID_ROLES = ["店舗", "メーカー", "ライター", "従業員", "その他"];

async function handleCreateUser(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorResponse("リクエストボディが不正です");
  }
  const { handle, display_name, role, area, bio } = body || {};
  if (!isValidHandle(handle)) {
    return errorResponse("handleは英数字・アンダースコアで2〜20文字にしてください");
  }
  if (typeof display_name !== "string" || display_name.length < 1 || display_name.length > 50) {
    return errorResponse("display_nameは1〜50文字で入力してください");
  }
  if (!VALID_ROLES.includes(role)) {
    return errorResponse(`roleは次のいずれかにしてください: ${VALID_ROLES.join(", ")}`);
  }
  if (area !== undefined && area !== null && (typeof area !== "string" || area.length > 50)) {
    return errorResponse("areaは50文字以内で入力してください");
  }
  if (bio !== undefined && bio !== null && (typeof bio !== "string" || bio.length > 300)) {
    return errorResponse("bioは300文字以内で入力してください");
  }

  const existing = await env.DB.prepare("SELECT id FROM users WHERE handle = ?").bind(handle).first();
  if (existing) {
    return errorResponse("そのhandleは既に使われています", 409);
  }

  const token = randomToken();
  const tokenHash = await sha256Hex(token);

  const result = await env.DB.prepare(
    "INSERT INTO users (handle, display_name, role, area, bio, token_hash) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(handle, display_name, role, area || null, bio || null, tokenHash)
    .run();

  return jsonResponse(
    {
      id: result.meta.last_row_id,
      handle,
      display_name,
      role,
      area: area || null,
      token,
    },
    201
  );
}

async function handleGetUser(env, handle) {
  const row = await env.DB.prepare(
    "SELECT id, handle, display_name, role, area, bio, created_at FROM users WHERE handle = ?"
  )
    .bind(handle)
    .first();
  if (!row) return errorResponse("ユーザーが見つかりません", 404);
  return jsonResponse(row);
}

async function handleListPosts(request, env) {
  const url = new URL(request.url);
  const tag = url.searchParams.get("tag");
  const cursor = url.searchParams.get("cursor"); // post id より古いものを取得

  if (tag && !TAGS.includes(tag)) {
    return errorResponse("不正なtagです");
  }

  const conditions = [];
  const binds = [];
  if (tag) {
    conditions.push("p.tag = ?");
    binds.push(tag);
  }
  if (cursor) {
    const cursorId = Number(cursor);
    if (!Number.isInteger(cursorId) || cursorId <= 0) {
      return errorResponse("不正なcursorです");
    }
    conditions.push("p.id < ?");
    binds.push(cursorId);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

  const query = `
    SELECT
      p.id, p.body, p.tag, p.created_at,
      u.handle, u.display_name, u.role,
      (SELECT COUNT(*) FROM replies r WHERE r.post_id = p.id) AS reply_count,
      (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count
    FROM posts p
    JOIN users u ON u.id = p.user_id
    ${where}
    ORDER BY p.id DESC
    LIMIT ?
  `;
  binds.push(PAGE_SIZE);

  const { results } = await env.DB.prepare(query).bind(...binds).all();
  const nextCursor = results.length === PAGE_SIZE ? results[results.length - 1].id : null;

  return jsonResponse({ posts: results, next_cursor: nextCursor });
}

async function handleGetPost(env, postId) {
  const post = await env.DB.prepare(
    `SELECT p.id, p.body, p.tag, p.created_at, u.handle, u.display_name, u.role,
       (SELECT COUNT(*) FROM likes l WHERE l.post_id = p.id) AS like_count
     FROM posts p JOIN users u ON u.id = p.user_id WHERE p.id = ?`
  )
    .bind(postId)
    .first();
  if (!post) return errorResponse("投稿が見つかりません", 404);

  const { results: replies } = await env.DB.prepare(
    `SELECT r.id, r.body, r.created_at, u.handle, u.display_name, u.role
     FROM replies r JOIN users u ON u.id = r.user_id
     WHERE r.post_id = ? ORDER BY r.id ASC`
  )
    .bind(postId)
    .all();

  return jsonResponse({ ...post, replies });
}

async function handleCreatePost(request, env) {
  const user = await getAuthedUser(request, env);
  if (!user) return errorResponse("認証が必要です", 401);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorResponse("リクエストボディが不正です");
  }
  const { body: text, tag } = body || {};
  if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_BODY_LEN) {
    return errorResponse(`本文は1〜${MAX_BODY_LEN}文字で入力してください`);
  }
  if (!TAGS.includes(tag)) {
    return errorResponse(`tagは次のいずれかにしてください: ${TAGS.join(", ")}`);
  }
  if (containsBannedWord(text)) {
    return errorResponse("業界広告規制に触れる可能性のある語が含まれています");
  }

  const result = await env.DB.prepare(
    "INSERT INTO posts (user_id, body, tag) VALUES (?, ?, ?)"
  )
    .bind(user.id, text, tag)
    .run();

  return jsonResponse({ id: result.meta.last_row_id, body: text, tag, handle: user.handle }, 201);
}

async function handleCreateReply(request, env, postId) {
  const user = await getAuthedUser(request, env);
  if (!user) return errorResponse("認証が必要です", 401);

  const post = await env.DB.prepare("SELECT id FROM posts WHERE id = ?").bind(postId).first();
  if (!post) return errorResponse("投稿が見つかりません", 404);

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return errorResponse("リクエストボディが不正です");
  }
  const { body: text } = body || {};
  if (typeof text !== "string" || text.trim().length === 0 || text.length > MAX_BODY_LEN) {
    return errorResponse(`本文は1〜${MAX_BODY_LEN}文字で入力してください`);
  }
  if (containsBannedWord(text)) {
    return errorResponse("業界広告規制に触れる可能性のある語が含まれています");
  }

  const result = await env.DB.prepare(
    "INSERT INTO replies (post_id, user_id, body) VALUES (?, ?, ?)"
  )
    .bind(postId, user.id, text)
    .run();

  return jsonResponse({ id: result.meta.last_row_id, post_id: postId, body: text, handle: user.handle }, 201);
}

async function handleToggleLike(request, env, postId) {
  const user = await getAuthedUser(request, env);
  if (!user) return errorResponse("認証が必要です", 401);

  const post = await env.DB.prepare("SELECT id FROM posts WHERE id = ?").bind(postId).first();
  if (!post) return errorResponse("投稿が見つかりません", 404);

  const existing = await env.DB.prepare(
    "SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?"
  )
    .bind(postId, user.id)
    .first();

  if (existing) {
    await env.DB.prepare("DELETE FROM likes WHERE post_id = ? AND user_id = ?")
      .bind(postId, user.id)
      .run();
  } else {
    await env.DB.prepare("INSERT INTO likes (post_id, user_id) VALUES (?, ?)")
      .bind(postId, user.id)
      .run();
  }

  const { count } = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM likes WHERE post_id = ?"
  )
    .bind(postId)
    .first();

  return jsonResponse({ liked: !existing, like_count: count });
}

function renderPage() {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>パチつな（仮）</title>
<style>
  :root {
    --bg: #0c0c10;
    --panel: #16161c;
    --border: #26262f;
    --text: #f2f2f5;
    --sub: #9a9aa5;
    --accent: #ff2d55;
    --accent2: #ffd60a;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Hiragino Sans", "Yu Gothic", sans-serif;
  }
  #app {
    max-width: 480px;
    margin: 0 auto;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
  }
  header {
    padding: 14px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 10;
  }
  header h1 {
    font-size: 18px;
    margin: 0;
    color: var(--accent);
  }
  header h1 span { color: var(--accent2); }
  nav button {
    background: none;
    border: 1px solid var(--border);
    color: var(--sub);
    padding: 6px 10px;
    border-radius: 8px;
    font-size: 12px;
    margin-left: 6px;
    cursor: pointer;
  }
  nav button.active { color: var(--text); border-color: var(--accent); }
  main { flex: 1; padding: 12px 16px 80px; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
  .tag-btn {
    background: var(--panel);
    border: 1px solid var(--border);
    color: var(--sub);
    padding: 5px 10px;
    border-radius: 999px;
    font-size: 12px;
    cursor: pointer;
  }
  .tag-btn.active { color: var(--bg); background: var(--accent2); border-color: var(--accent2); font-weight: bold; }
  .post-card, .reply-card {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 12px;
    margin-bottom: 10px;
    cursor: pointer;
  }
  .reply-card { cursor: default; }
  .post-meta { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--sub); margin-bottom: 6px; }
  .role-badge {
    background: rgba(255,45,85,0.15);
    color: var(--accent);
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: bold;
  }
  .post-body { font-size: 14px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; }
  .post-tag { display: inline-block; margin-top: 8px; font-size: 11px; color: var(--accent2); }
  .post-stats { margin-top: 8px; font-size: 12px; color: var(--sub); display: flex; gap: 12px; }
  .like-btn { cursor: pointer; background: none; border: none; color: var(--sub); font-size: 12px; }
  .like-btn.liked { color: var(--accent); font-weight: bold; }
  form { display: flex; flex-direction: column; gap: 10px; }
  label { font-size: 12px; color: var(--sub); }
  input, textarea, select {
    background: var(--panel);
    border: 1px solid var(--border);
    color: var(--text);
    border-radius: 8px;
    padding: 10px;
    font-size: 14px;
    width: 100%;
    font-family: inherit;
  }
  textarea { min-height: 100px; resize: vertical; }
  button.primary {
    background: var(--accent);
    color: white;
    border: none;
    border-radius: 999px;
    padding: 12px;
    font-size: 14px;
    font-weight: bold;
    cursor: pointer;
  }
  button.primary:disabled { opacity: 0.5; }
  .msg { font-size: 12px; padding: 8px; border-radius: 8px; margin-bottom: 8px; }
  .msg.error { background: rgba(255,45,85,0.15); color: var(--accent); }
  .msg.ok { background: rgba(255,214,10,0.15); color: var(--accent2); }
  .back-btn { background: none; border: none; color: var(--sub); font-size: 13px; margin-bottom: 10px; cursor: pointer; }
  .empty { color: var(--sub); text-align: center; padding: 40px 0; font-size: 13px; }
  footer.tabbar {
    position: fixed;
    bottom: 0; left: 50%;
    transform: translateX(-50%);
    width: 100%;
    max-width: 480px;
    background: var(--panel);
    border-top: 1px solid var(--border);
    display: flex;
  }
  footer.tabbar button {
    flex: 1;
    background: none;
    border: none;
    color: var(--sub);
    padding: 12px 0;
    font-size: 12px;
    cursor: pointer;
  }
  footer.tabbar button.active { color: var(--accent); font-weight: bold; }
  .loadmore { width: 100%; padding: 10px; background: var(--panel); border: 1px solid var(--border); color: var(--sub); border-radius: 8px; cursor: pointer; font-size: 12px; }
</style>
</head>
<body>
<div id="app">
  <header>
    <h1>パチ<span>つな</span></h1>
    <div id="profileArea"></div>
  </header>
  <main id="main"></main>
  <footer class="tabbar">
    <button data-view="timeline">タイムライン</button>
    <button data-view="post">投稿</button>
    <button data-view="profile">プロフィール</button>
  </footer>
</div>
<script>
const TAGS = ${JSON.stringify(TAGS)};
const ROLES = ${JSON.stringify(VALID_ROLES)};
const state = {
  view: "timeline",
  tag: null,
  cursor: null,
  posts: [],
  detailPost: null,
  user: JSON.parse(localStorage.getItem("pachitsuna_user") || "null"),
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function authHeaders() {
  if (!state.user) return {};
  return { Authorization: "Bearer " + state.user.token };
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "エラーが発生しました");
  return data;
}

function renderProfileArea() {
  const el = document.getElementById("profileArea");
  if (state.user) {
    el.innerHTML = '<span style="font-size:12px;color:var(--sub)">@' + escapeHtml(state.user.handle) + '</span>';
  } else {
    el.innerHTML = '<span style="font-size:12px;color:var(--sub)">未登録</span>';
  }
}

async function loadTimeline(reset = true) {
  if (reset) { state.posts = []; state.cursor = null; }
  const params = new URLSearchParams();
  if (state.tag) params.set("tag", state.tag);
  if (state.cursor) params.set("cursor", state.cursor);
  const data = await api("/api/posts?" + params.toString());
  state.posts = reset ? data.posts : state.posts.concat(data.posts);
  state.cursor = data.next_cursor;
  renderTimeline();
}

function renderTimeline() {
  const main = document.getElementById("main");
  const tagsHtml = '<div class="tags">' +
    '<button class="tag-btn ' + (state.tag === null ? "active" : "") + '" data-tag="">すべて</button>' +
    TAGS.map((t) => '<button class="tag-btn ' + (state.tag === t ? "active" : "") + '" data-tag="' + escapeHtml(t) + '">' + escapeHtml(t) + '</button>').join("") +
    '</div>';

  const postsHtml = state.posts.length
    ? state.posts.map(postCardHtml).join("")
    : '<div class="empty">まだ投稿がありません</div>';

  const loadMore = state.cursor ? '<button class="loadmore" id="loadMoreBtn">もっと見る</button>' : "";

  main.innerHTML = tagsHtml + '<div id="postsList">' + postsHtml + '</div>' + loadMore;

  main.querySelectorAll(".tag-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.tag = btn.dataset.tag || null;
      loadTimeline(true);
    });
  });
  main.querySelectorAll(".post-card").forEach((card) => {
    card.addEventListener("click", (e) => {
      if (e.target.closest(".like-btn")) return;
      openPost(Number(card.dataset.id));
    });
  });
  main.querySelectorAll(".like-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!requireLogin()) return;
      try {
        const data = await api("/api/posts/" + btn.dataset.id + "/like", { method: "POST" });
        btn.textContent = (data.liked ? "♥ " : "♡ ") + data.like_count;
        btn.classList.toggle("liked", data.liked);
      } catch (err) { alert(err.message); }
    });
  });
  const loadMoreBtn = document.getElementById("loadMoreBtn");
  if (loadMoreBtn) loadMoreBtn.addEventListener("click", () => loadTimeline(false));
}

function postCardHtml(p) {
  return '<div class="post-card" data-id="' + p.id + '">' +
    '<div class="post-meta"><span class="role-badge">' + escapeHtml(p.role) + '</span>' +
    '<span>' + escapeHtml(p.display_name) + ' @' + escapeHtml(p.handle) + '</span></div>' +
    '<div class="post-body">' + escapeHtml(p.body) + '</div>' +
    '<span class="post-tag">#' + escapeHtml(p.tag) + '</span>' +
    '<div class="post-stats">' +
    '<span>返信 ' + p.reply_count + '</span>' +
    '<button class="like-btn" data-id="' + p.id + '">♡ ' + p.like_count + '</button>' +
    '</div></div>';
}

async function openPost(id) {
  try {
    const post = await api("/api/posts/" + id);
    state.detailPost = post;
    renderDetail();
  } catch (err) { alert(err.message); }
}

function renderDetail() {
  const p = state.detailPost;
  const main = document.getElementById("main");
  const repliesHtml = p.replies.length
    ? p.replies.map((r) => '<div class="reply-card">' +
        '<div class="post-meta"><span class="role-badge">' + escapeHtml(r.role) + '</span>' +
        '<span>' + escapeHtml(r.display_name) + ' @' + escapeHtml(r.handle) + '</span></div>' +
        '<div class="post-body">' + escapeHtml(r.body) + '</div></div>').join("")
    : '<div class="empty">まだ返信がありません</div>';

  main.innerHTML =
    '<button class="back-btn" id="backBtn">← 戻る</button>' +
    postCardHtml(p) +
    '<div id="detailMsg"></div>' +
    '<form id="replyForm"><textarea id="replyBody" placeholder="返信する" maxlength="500"></textarea>' +
    '<button type="submit" class="primary">返信する</button></form>' +
    '<div style="margin-top:16px">' + repliesHtml + '</div>';

  document.getElementById("backBtn").addEventListener("click", () => { state.detailPost = null; setView("timeline"); });
  main.querySelector(".like-btn").addEventListener("click", async () => {
    if (!requireLogin()) return;
    try {
      const data = await api("/api/posts/" + p.id + "/like", { method: "POST" });
      p.like_count = data.like_count;
      openPost(p.id);
    } catch (err) { alert(err.message); }
  });
  document.getElementById("replyForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!requireLogin()) return;
    const body = document.getElementById("replyBody").value.trim();
    const msgEl = document.getElementById("detailMsg");
    if (!body) return;
    try {
      await api("/api/posts/" + p.id + "/replies", { method: "POST", body: JSON.stringify({ body }) });
      openPost(p.id);
    } catch (err) {
      msgEl.innerHTML = '<div class="msg error">' + escapeHtml(err.message) + '</div>';
    }
  });
}

function requireLogin() {
  if (!state.user) {
    alert("先にプロフィール登録をしてください");
    setView("profile");
    return false;
  }
  return true;
}

function renderPostForm() {
  const main = document.getElementById("main");
  if (!state.user) {
    main.innerHTML = '<div class="msg error">投稿するには先にプロフィール登録が必要です</div>';
    return;
  }
  main.innerHTML =
    '<div id="postMsg"></div>' +
    '<form id="postForm">' +
    '<label>タグ</label><select id="postTag">' + TAGS.map((t) => '<option value="' + escapeHtml(t) + '">' + escapeHtml(t) + '</option>').join("") + '</select>' +
    '<label>本文（500字まで）</label><textarea id="postBody" maxlength="500" placeholder="現場のリアルを共有しよう"></textarea>' +
    '<button type="submit" class="primary">投稿する</button>' +
    '</form>';

  document.getElementById("postForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = document.getElementById("postBody").value.trim();
    const tag = document.getElementById("postTag").value;
    const msgEl = document.getElementById("postMsg");
    if (!body) return;
    try {
      await api("/api/posts", { method: "POST", body: JSON.stringify({ body, tag }) });
      msgEl.innerHTML = '<div class="msg ok">投稿しました</div>';
      document.getElementById("postBody").value = "";
      setView("timeline");
    } catch (err) {
      msgEl.innerHTML = '<div class="msg error">' + escapeHtml(err.message) + '</div>';
    }
  });
}

function renderProfileForm() {
  const main = document.getElementById("main");
  if (state.user) {
    main.innerHTML =
      '<div class="post-card">' +
      '<div class="post-meta"><span class="role-badge">' + escapeHtml(state.user.role) + '</span>' +
      '<span>' + escapeHtml(state.user.display_name) + ' @' + escapeHtml(state.user.handle) + '</span></div>' +
      (state.user.area ? '<div style="font-size:12px;color:var(--sub);margin-top:6px">エリア: ' + escapeHtml(state.user.area) + '</div>' : '') +
      '</div>' +
      '<button class="loadmore" id="logoutBtn">このデバイスからログアウト</button>';
    document.getElementById("logoutBtn").addEventListener("click", () => {
      state.user = null;
      localStorage.removeItem("pachitsuna_user");
      renderProfileArea();
      renderProfileForm();
    });
    return;
  }
  main.innerHTML =
    '<div id="profileMsg"></div>' +
    '<form id="profileForm">' +
    '<label>ハンドル（英数字・アンダースコア 2〜20文字）</label><input id="pfHandle" placeholder="pachi_taro">' +
    '<label>表示名</label><input id="pfName" placeholder="山田太郎">' +
    '<label>立場</label><select id="pfRole">' + ROLES.map((r) => '<option value="' + r + '">' + r + '</option>').join("") + '</select>' +
    '<label>エリア（任意）</label><input id="pfArea" placeholder="東京都">' +
    '<button type="submit" class="primary">登録する</button>' +
    '</form>';

  document.getElementById("profileForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const handle = document.getElementById("pfHandle").value.trim();
    const display_name = document.getElementById("pfName").value.trim();
    const role = document.getElementById("pfRole").value;
    const area = document.getElementById("pfArea").value.trim();
    const msgEl = document.getElementById("profileMsg");
    try {
      const data = await api("/api/users", { method: "POST", body: JSON.stringify({ handle, display_name, role, area }) });
      state.user = data;
      localStorage.setItem("pachitsuna_user", JSON.stringify(data));
      renderProfileArea();
      setView("timeline");
    } catch (err) {
      msgEl.innerHTML = '<div class="msg error">' + escapeHtml(err.message) + '</div>';
    }
  });
}

function setView(view) {
  state.view = view;
  document.querySelectorAll("footer.tabbar button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  if (view === "timeline") loadTimeline(true);
  else if (view === "post") renderPostForm();
  else if (view === "profile") renderProfileForm();
}

document.querySelectorAll("footer.tabbar button").forEach((btn) => {
  btn.addEventListener("click", () => setView(btn.dataset.view));
});

renderProfileArea();
setView("timeline");
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      if (path === "/" && method === "GET") {
        return new Response(renderPage(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (path === "/api/users" && method === "POST") {
        return await handleCreateUser(request, env);
      }

      const userHandleMatch = path.match(/^\/api\/users\/([^/]+)$/);
      if (userHandleMatch && method === "GET") {
        return await handleGetUser(env, decodeURIComponent(userHandleMatch[1]));
      }

      if (path === "/api/posts" && method === "GET") {
        return await handleListPosts(request, env);
      }
      if (path === "/api/posts" && method === "POST") {
        return await handleCreatePost(request, env);
      }

      const postIdMatch = path.match(/^\/api\/posts\/(\d+)$/);
      if (postIdMatch && method === "GET") {
        return await handleGetPost(env, Number(postIdMatch[1]));
      }

      const replyMatch = path.match(/^\/api\/posts\/(\d+)\/replies$/);
      if (replyMatch && method === "POST") {
        return await handleCreateReply(request, env, Number(replyMatch[1]));
      }

      const likeMatch = path.match(/^\/api\/posts\/(\d+)\/like$/);
      if (likeMatch && method === "POST") {
        return await handleToggleLike(request, env, Number(likeMatch[1]));
      }

      return errorResponse("Not Found", 404);
    } catch (err) {
      return errorResponse("サーバーエラーが発生しました: " + err.message, 500);
    }
  },
};
