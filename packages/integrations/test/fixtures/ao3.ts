// Original controlled content, matching the pinned AO3 templates' structural selectors.
export const greeting = (user = "reader") =>
  `<nav id="greeting"><ul><li><a href="/users/${user}">Hi, ${user}!</a></li><li><a href="/users/logout">Log out</a></li></ul></nav>`;
export const loginForm =
  '<form action="/users/login"><input type="hidden" name="authenticity_token" value="csrf+token=="><input name="user[login]"><input name="user[password]"></form>';
export const subscriptions = (user = "reader", next = false) =>
  `${greeting(user)}<dl class="subscription index group"><dt><a href="/works/123">A Lantern at Sea</a> by <a rel="author" href="/users/writer/pseuds/writer">writer</a></dt><dd>Subscription controls</dd><dt>Unrevealed work</dt><dd>Subscription controls</dd></dl>${next ? `<div class="pagination"><a class="next_page" rel="next" href="/users/${user}/subscriptions?type=works&amp;page=2">Next</a></div>` : ""}`;
export const chapterIndex = (ids = ["11", "12"], user = "reader") =>
  `${greeting(user)}<ol class="chapter index group">${ids.map((id, index) => `<li><a href="/works/123/chapters/${id}">Chapter ${index + 1}</a><span class="datetime">(2026-10-01)</span></li>`).join("")}</ol>`;
export const workPage = (
  ids = ["11", "12"],
  changed = false,
  user = "reader",
) =>
  `${greeting(user)}<ul class="work navigation actions"><li class="download"><ul><li><a href="/downloads/123/A_Lantern.epub?updated_at=10">EPUB</a></li></ul></li></ul><div id="workskin"><div class="preface group"><h2 class="title heading">A Lantern at Sea</h2><h3 class="byline heading"><a rel="author" href="/users/writer">writer</a></h3></div><div id="chapters">${ids.map((id, index) => `<div class="chapter" id="chapter-${index + 1}"><div class="chapter preface group"><h3 class="title"><a href="/works/123/chapters/${id}">Chapter ${index + 1}</a></h3></div><div class="userstuff module" role="article"><p>The light crossed the ${changed && index === 0 ? "quiet" : "open"} water. Passage ${id}.</p></div></div>`).join("")}</div></div>`;
