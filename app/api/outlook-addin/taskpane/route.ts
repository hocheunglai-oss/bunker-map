import { NextResponse } from "next/server"

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function buildBaseUrl(request: Request) {
  const configured = process.env.NEXT_PUBLIC_SITE_URL
  if (configured) return configured.replace(/\/$/, "")

  const url = new URL(request.url)
  return `${url.protocol}//${url.host}`
}

export async function GET(request: Request) {
  const baseUrl = buildBaseUrl(request)
  const templateIndexUrl = `${baseUrl}/api/email-templates?mode=index`
  const templateDetailUrl = `${baseUrl}/api/email-templates`

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fratelli Cosulich Templates</title>
    <script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>
    <style>
      * { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body {
        margin: 0;
        background: #f4f6f8;
        color: #172534;
        font-family: Arial, Helvetica, sans-serif;
      }
      button, input { font: inherit; }
      .app { display: grid; gap: 8px; padding: 8px; }
      .search {
        width: 100%;
        height: 38px;
        border: 1px solid #c4d0da;
        border-radius: 7px;
        background: #fff;
        color: #172534;
        outline: none;
        padding: 0 10px;
      }
      .search:focus { border-color: #1672b9; box-shadow: 0 0 0 3px rgba(22, 114, 185, 0.12); }
      .panel {
        border: 1px solid #dbe4ec;
        border-radius: 8px;
        background: #fff;
        overflow: hidden;
      }
      .panelHeader {
        min-height: 32px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 7px 9px;
        border-bottom: 1px solid #e4ebf1;
        background: #fbfcfd;
        color: #435565;
        font-size: 12px;
        font-weight: 900;
        text-transform: uppercase;
      }
      .folders { max-height: 35vh; overflow: auto; padding: 5px; }
      .templates { max-height: 54vh; overflow: auto; padding: 5px; }
      .folderNode { position: relative; }
      .folderChildren {
        margin-left: 9px;
        padding-left: 8px;
        border-left: 1px solid #d9e5ee;
      }
      .folderRow {
        width: 100%;
        min-height: 28px;
        display: grid;
        grid-template-columns: 16px minmax(0, 1fr);
        align-items: center;
        gap: 5px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: #203246;
        cursor: pointer;
        text-align: left;
      }
      .folderRow.active { background: #dff0fb; color: #0c4774; }
      .folderToggle {
        color: #6a7f91;
        font-size: 12px;
        font-weight: 900;
        text-align: center;
      }
      .folderName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 800; }
      .templateGridHeader {
        display: none;
        gap: 8px;
        padding: 0 9px 5px;
        color: #6a7a89;
        font-size: 10px;
        font-weight: 900;
        text-transform: uppercase;
      }
      .templateRow {
        width: 100%;
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 8px;
        align-items: center;
        margin-bottom: 5px;
        padding: 8px 9px;
        border: 1px solid #e2e9ef;
        border-radius: 7px;
        background: #fff;
        color: #1b2d40;
        cursor: pointer;
        text-align: left;
      }
      .templateRow.active { border-color: #2c86c6; background: #eef7ff; }
      .recipient {
        display: none;
        min-width: 0;
        color: #536676;
        font-size: 12px;
        font-weight: 800;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .title { min-width: 0; display: block; font-size: 13px; font-weight: 900; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      @media (min-width: 520px) {
        .templateGridHeader { display: grid; grid-template-columns: minmax(92px, 34%) minmax(0, 1fr); }
        .templateRow { grid-template-columns: minmax(92px, 34%) minmax(0, 1fr); }
        .recipient { display: block; }
      }
      .empty { padding: 14px 10px; color: #617487; font-size: 12px; line-height: 1.45; }
      .notice {
        min-height: 18px;
        color: #526679;
        font-size: 11px;
        line-height: 1.35;
      }
      .notice.error { color: #a12a2a; }
      .notice.success { color: #1d6a3b; }
    </style>
  </head>
  <body>
    <div class="app">
      <input id="searchInput" class="search" type="search" placeholder="Search templates" autocomplete="off" />
      <section class="panel">
        <div class="panelHeader"><span>Folders</span></div>
        <div id="folderTree" class="folders"><div class="empty">Loading...</div></div>
      </section>
      <section class="panel">
        <div class="panelHeader"><span id="listTitle">Templates</span></div>
        <div id="templateList" class="templates"><div class="empty">Loading...</div></div>
      </section>
      <div id="notice" class="notice"></div>
    </div>

    <script>
      (function () {
        var TEMPLATE_INDEX_URL = ${JSON.stringify(templateIndexUrl)};
        var TEMPLATE_DETAIL_URL = ${JSON.stringify(templateDetailUrl)};
        var INDEX_CACHE_KEY = "fcuno-outlook-template-index-v2";
        var state = {
          templates: [],
          detailCache: {},
          folderRoot: null,
          folderIndex: {},
          expanded: { "": true },
          selectedFolder: "",
          selectedId: "",
          query: "",
          composeReady: false
        };

        var els = {
          search: document.getElementById("searchInput"),
          folderTree: document.getElementById("folderTree"),
          listTitle: document.getElementById("listTitle"),
          templateList: document.getElementById("templateList"),
          notice: document.getElementById("notice")
        };

        function notice(text, kind) {
          els.notice.textContent = text || "";
          els.notice.className = "notice" + (kind ? " " + kind : "");
        }

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        function normaliseTemplate(input) {
          return {
            id: String(input && input.id || ""),
            title: String(input && input.title || "Untitled template"),
            subject: String(input && input.subject || ""),
            folder: String(input && input.folder || "Unfiled"),
            to: String(input && input.to || ""),
            cc: String(input && input.cc || ""),
            bcc: String(input && input.bcc || ""),
            bodyHtml: String(input && input.bodyHtml || "<p></p>"),
            bodyText: String(input && input.bodyText || "")
          };
        }

        function compactRecipients(value) {
          var parts = String(value || "")
            .replace(/\\r?\\n/g, ",")
            .split(/[;,]/)
            .map(function (part) { return part.trim(); })
            .filter(Boolean)
            .map(function (part) {
              var bracket = part.match(/^(.*?)<([^>]+)>$/);
              var label = bracket ? bracket[1].replace(/^"|"$/g, "").trim() : part;
              return label || (bracket ? bracket[2].trim() : part);
            })
            .slice(0, 2);
          return parts.join(", ");
        }

        function recipientSummary(template) {
          if (template.to) return "To: " + compactRecipients(template.to);
          if (template.cc) return "Cc: " + compactRecipients(template.cc);
          if (template.bcc) return "Bcc: " + compactRecipients(template.bcc);
          return "-";
        }

        function folderParts(folder) {
          return String(folder || "Unfiled").split(" / ").map(function (part) {
            return part.trim();
          }).filter(Boolean);
        }

        function createFolderNode(name, path, depth) {
          return { name: name, path: path, depth: depth, children: [], templates: [], totalCount: 0 };
        }

        function buildFolderTree(templates) {
          var root = createFolderNode("All templates", "", 0);
          var index = { "": root };

          templates.forEach(function (template) {
            var node = root;
            folderParts(template.folder).forEach(function (part, partIndex) {
              var nextPath = node.path ? node.path + " / " + part : part;
              if (!index[nextPath]) {
                index[nextPath] = createFolderNode(part, nextPath, partIndex + 1);
                node.children.push(index[nextPath]);
              }
              node = index[nextPath];
            });
            node.templates.push(template);
          });

          function sortAndCount(node) {
            node.children.sort(function (a, b) { return a.name.localeCompare(b.name); });
            node.templates.sort(function (a, b) { return a.title.localeCompare(b.title); });
            node.totalCount = node.templates.length + node.children.reduce(function (sum, child) {
              return sum + sortAndCount(child);
            }, 0);
            return node.totalCount;
          }

          sortAndCount(root);
          return { root: root, index: index };
        }

        function folderContains(template, folder) {
          if (!folder) return true;
          return template.folder === folder || template.folder.indexOf(folder + " / ") === 0;
        }

        function normaliseSearchText(value) {
          return String(value || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\\s+/g, " ")
            .trim();
        }

        function matchesQuery(template, query) {
          var tokens = normaliseSearchText(query).split(" ").filter(Boolean);
          if (!tokens.length) return true;
          var haystack = normaliseSearchText([template.title, template.subject, template.folder, template.to, template.cc, template.bcc].join(" "));
          return tokens.every(function (token) { return haystack.indexOf(token) !== -1; });
        }

        function visibleTemplates() {
          var query = state.query.trim();
          return state.templates.filter(function (template) {
            return matchesQuery(template, query) && folderContains(template, state.selectedFolder);
          });
        }

        function expandPath(path) {
          state.expanded[""] = true;
          var cursor = "";
          folderParts(path).forEach(function (part) {
            cursor = cursor ? cursor + " / " + part : part;
            state.expanded[cursor] = true;
          });
        }

        function chooseInitialFolder() {
          var preferred = ["Outgoing / Bunker", "Internal / Outgoing / Bunker", "Outgoing / Account", "FCBV"];
          for (var i = 0; i < preferred.length; i += 1) {
            if (state.folderIndex[preferred[i]]) return preferred[i];
          }
          return Object.keys(state.folderIndex).find(function (path) { return path; }) || "";
        }

        function renderFolderNode(node) {
          var container = document.createElement("div");
          var row = document.createElement("button");
          var arrow = document.createElement("span");
          var name = document.createElement("span");
          var hasChildren = node.children.length > 0;

          container.className = "folderNode";
          row.type = "button";
          row.className = "folderRow" + (state.selectedFolder === node.path ? " active" : "");
          row.addEventListener("click", function () {
            state.selectedFolder = node.path;
            expandPath(node.path);
            var visible = visibleTemplates();
            state.selectedId = visible[0] ? visible[0].id : "";
            render();
          });

          arrow.className = "folderToggle";
          arrow.textContent = hasChildren ? (state.expanded[node.path] || state.query ? "-" : "+") : "";
          arrow.addEventListener("click", function (event) {
            event.stopPropagation();
            if (!hasChildren) return;
            state.expanded[node.path] = !state.expanded[node.path];
            renderFolders();
          });
          name.className = "folderName";
          name.textContent = node.name;
          row.appendChild(arrow);
          row.appendChild(name);
          container.appendChild(row);

          if (hasChildren && (state.expanded[node.path] || state.query)) {
            var children = document.createElement("div");
            children.className = "folderChildren";
            node.children.forEach(function (child) { children.appendChild(renderFolderNode(child)); });
            container.appendChild(children);
          }

          return container;
        }

        function renderFolders() {
          if (!state.folderRoot) return;
          var tree = state.query ? buildFolderTree(state.templates.filter(function (template) {
            return matchesQuery(template, state.query);
          })).root : state.folderRoot;
          els.folderTree.innerHTML = "";
          if (!tree.totalCount) {
            els.folderTree.innerHTML = '<div class="empty">No matching folders.</div>';
            return;
          }
          els.folderTree.appendChild(renderFolderNode(tree));
        }

        function renderTemplates() {
          var visible = visibleTemplates();
          if (!visible.some(function (template) { return template.id === state.selectedId; })) {
            state.selectedId = visible[0] ? visible[0].id : "";
          }

          els.listTitle.textContent = state.query ? "Search results" : (state.selectedFolder || "All templates");
          els.templateList.innerHTML = "";

          if (!visible.length) {
            els.templateList.innerHTML = '<div class="empty">No templates found.</div>';
            return;
          }

          var header = document.createElement("div");
          header.className = "templateGridHeader";
          header.innerHTML = "<span>Recipient</span><span>Subject</span>";
          els.templateList.appendChild(header);

          visible.forEach(function (template) {
            var row = document.createElement("button");
            var subject = template.subject || template.title || "Untitled template";
            row.type = "button";
            row.className = "templateRow" + (template.id === state.selectedId ? " active" : "");
            row.addEventListener("click", function () {
              state.selectedId = template.id;
              renderTemplates();
            });
            row.addEventListener("dblclick", function () {
              state.selectedId = template.id;
              insertSelectedTemplate();
            });
            row.innerHTML =
              '<span class="recipient">' + escapeHtml(recipientSummary(template)) + '</span>' +
              '<span class="title">' + escapeHtml(subject) + '</span>';
            els.templateList.appendChild(row);
          });
        }

        function render() {
          renderFolders();
          renderTemplates();
        }

        function markComposeReady() {
          var office = window.Office;
          var item = office && office.context && office.context.mailbox && office.context.mailbox.item;
          var canSetSubject = item && item.subject && typeof item.subject.setAsync === "function";
          var canInsertBody = item && item.body && typeof item.body.setSelectedDataAsync === "function";
          state.composeReady = Boolean(canSetSubject && canInsertBody);
        }

        function officeAsync(call) {
          return new Promise(function (resolve, reject) {
            call(function (result) {
              var office = window.Office;
              if (office && result && result.status === office.AsyncResultStatus.Succeeded) {
                resolve(result.value);
                return;
              }
              reject(new Error(result && result.error && result.error.message ? result.error.message : "Outlook action failed."));
            });
          });
        }

        function parseRecipients(value) {
          return String(value || "")
            .replace(/\\r?\\n/g, ",")
            .split(/[;,]/)
            .map(function (part) { return part.trim(); })
            .filter(Boolean)
            .map(function (part) {
              var bracket = part.match(/^(.*?)<([^>]+)>$/);
              var email = bracket ? bracket[2].trim() : part;
              var name = bracket ? bracket[1].replace(/^"|"$/g, "").trim() : "";
              if (!/@/.test(email)) return null;
              return name ? { displayName: name, emailAddress: email } : { emailAddress: email };
            })
            .filter(Boolean);
        }

        async function addRecipients(recipientApi, value) {
          var recipients = parseRecipients(value);
          if (!recipients.length || !recipientApi) return;
          if (typeof recipientApi.addAsync === "function") {
            await officeAsync(function (done) { recipientApi.addAsync(recipients, done); });
            return;
          }
          if (typeof recipientApi.setAsync === "function") {
            await officeAsync(function (done) { recipientApi.setAsync(recipients, done); });
          }
        }

        async function loadTemplateDetail(id) {
          if (!id) return null;
          var indexTemplate = state.templates.find(function (template) { return template.id === id; }) || null;
          var cacheKey = id + ":" + (indexTemplate && indexTemplate.updatedAt || "");
          if (state.detailCache[cacheKey]) return state.detailCache[cacheKey];

          var response = await fetch(TEMPLATE_DETAIL_URL + "?id=" + encodeURIComponent(id), { cache: "no-cache" });
          if (!response.ok) throw new Error("Template detail returned " + response.status + ".");
          var data = await response.json();
          var template = normaliseTemplate(Object.assign({}, indexTemplate || {}, data.template || {}));
          state.detailCache[cacheKey] = template;
          return template;
        }

        async function insertSelectedTemplate() {
          markComposeReady();
          var office = window.Office;
          var item = office && office.context && office.context.mailbox && office.context.mailbox.item;

          if (!state.selectedId) return;
          if (!state.composeReady) {
            notice("Open New mail, then double click a template to insert.", "error");
            return;
          }

          notice("Loading template...", "");
          try {
            var template = await loadTemplateDetail(state.selectedId);
            if (!template) throw new Error("Template not found.");
            notice("Inserting...", "");
            await officeAsync(function (done) { item.subject.setAsync(template.subject || "", done); });
            await addRecipients(item.to, template.to);
            await addRecipients(item.cc, template.cc);
            await addRecipients(item.bcc, template.bcc);
            var bodyType = await officeAsync(function (done) { item.body.getTypeAsync(done); });
            var isHtml = bodyType === office.MailboxEnums.BodyType.Html;
            await officeAsync(function (done) {
              item.body.setSelectedDataAsync(isHtml ? template.bodyHtml : template.bodyText, {
                coercionType: isHtml ? office.CoercionType.Html : office.CoercionType.Text
              }, done);
            });
            notice("Inserted.", "success");
          } catch (error) {
            notice(error && error.message ? error.message : "Insert failed.", "error");
          }
        }

        async function loadTemplates() {
          function applyTemplateIndex(data, keepSelection) {
            var previousFolder = state.selectedFolder;
            var previousId = state.selectedId;
            state.templates = Array.isArray(data.templates) ? data.templates.map(normaliseTemplate) : [];
            state.templates.sort(function (a, b) { return a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title); });
            var built = buildFolderTree(state.templates);
            state.folderRoot = built.root;
            state.folderIndex = built.index;
            if (keepSelection && state.folderIndex[previousFolder]) {
              state.selectedFolder = previousFolder;
            } else {
              state.selectedFolder = chooseInitialFolder();
            }
            expandPath(state.selectedFolder);
            var visible = visibleTemplates();
            state.selectedId = keepSelection && visible.some(function (template) { return template.id === previousId; })
              ? previousId
              : (visible[0] ? visible[0].id : "");
            render();
          }

          function loadCachedIndex() {
            try {
              var cached = window.localStorage && window.localStorage.getItem(INDEX_CACHE_KEY);
              if (!cached) return false;
              var data = JSON.parse(cached);
              if (!data || !Array.isArray(data.templates)) return false;
              applyTemplateIndex(data, false);
              return true;
            } catch (error) {
              return false;
            }
          }

          function saveCachedIndex(data) {
            try {
              if (window.localStorage) window.localStorage.setItem(INDEX_CACHE_KEY, JSON.stringify(data));
            } catch (error) {
              return;
            }
          }

          var hadCache = loadCachedIndex();
          try {
            var response = await fetch(TEMPLATE_INDEX_URL, { cache: "no-cache" });
            if (!response.ok) throw new Error("Template API returned " + response.status + ".");
            var data = await response.json();
            saveCachedIndex(data);
            applyTemplateIndex(data, hadCache);
            notice("", "");
          } catch (error) {
            if (!hadCache) {
              els.folderTree.innerHTML = '<div class="empty">Could not load folders.</div>';
              els.templateList.innerHTML = '<div class="empty">' + escapeHtml(error && error.message ? error.message : "Could not load templates.") + '</div>';
            } else {
              notice("Using saved template index. Refresh later for latest edits.", "error");
            }
          }
        }

        els.search.addEventListener("input", function () {
          state.query = els.search.value.trim();
          state.selectedFolder = "";
          state.selectedId = visibleTemplates()[0] ? visibleTemplates()[0].id : "";
          render();
        });

        if (window.Office && typeof window.Office.onReady === "function") {
          window.Office.onReady(function () { markComposeReady(); });
        } else {
          markComposeReady();
        }

        loadTemplates();
      })();
    </script>
  </body>
</html>`

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
      "Access-Control-Allow-Origin": "*",
    },
  })
}
