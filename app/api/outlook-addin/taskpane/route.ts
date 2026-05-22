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
  const templatesUrl = `${baseUrl}/api/email-templates`

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
      .meta { color: #687a88; font-size: 11px; font-weight: 700; text-transform: none; }
      .folders { max-height: 35vh; overflow: auto; padding: 5px; }
      .templates { max-height: 54vh; overflow: auto; padding: 5px; }
      .folderRow {
        width: 100%;
        min-height: 28px;
        display: grid;
        grid-template-columns: 16px minmax(0, 1fr) auto;
        align-items: center;
        gap: 4px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: #203246;
        cursor: pointer;
        text-align: left;
      }
      .folderRow.active { background: #dff0fb; color: #0c4774; }
      .folderName { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 800; }
      .count {
        min-width: 22px;
        border-radius: 999px;
        padding: 2px 6px;
        background: #eef3f7;
        color: #586a7b;
        font-size: 11px;
        font-weight: 800;
        text-align: center;
      }
      .folderRow.active .count { background: #fff; color: #0c4774; }
      .templateRow {
        width: 100%;
        display: block;
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
      .title { display: block; font-size: 13px; font-weight: 900; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
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
        <div class="panelHeader"><span>Folders</span><span id="folderMeta" class="meta">0</span></div>
        <div id="folderTree" class="folders"><div class="empty">Loading...</div></div>
      </section>
      <section class="panel">
        <div class="panelHeader"><span id="listTitle">Templates</span><span id="listMeta" class="meta">0</span></div>
        <div id="templateList" class="templates"><div class="empty">Loading...</div></div>
      </section>
      <div id="notice" class="notice"></div>
    </div>

    <script>
      (function () {
        var TEMPLATE_API_URL = ${JSON.stringify(templatesUrl)};
        var state = {
          templates: [],
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
          folderMeta: document.getElementById("folderMeta"),
          folderTree: document.getElementById("folderTree"),
          listTitle: document.getElementById("listTitle"),
          listMeta: document.getElementById("listMeta"),
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

        function matchesQuery(template, query) {
          if (!query) return true;
          return [template.title, template.subject, template.folder, template.bodyText].join(" ").toLowerCase().indexOf(query) !== -1;
        }

        function visibleTemplates() {
          var query = state.query.trim().toLowerCase();
          return state.templates.filter(function (template) {
            return query ? matchesQuery(template, query) : folderContains(template, state.selectedFolder);
          });
        }

        function selectedTemplate() {
          return state.templates.find(function (template) { return template.id === state.selectedId; }) || null;
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
          var count = document.createElement("span");
          var hasChildren = node.children.length > 0;

          row.type = "button";
          row.className = "folderRow" + (state.selectedFolder === node.path && !state.query ? " active" : "");
          row.style.paddingLeft = Math.min(node.depth * 13, 65) + "px";
          row.addEventListener("click", function () {
            state.query = "";
            els.search.value = "";
            state.selectedFolder = node.path;
            expandPath(node.path);
            var visible = visibleTemplates();
            state.selectedId = visible[0] ? visible[0].id : "";
            render();
          });

          arrow.textContent = hasChildren ? (state.expanded[node.path] ? "v" : ">") : "";
          arrow.addEventListener("click", function (event) {
            event.stopPropagation();
            if (!hasChildren) return;
            state.expanded[node.path] = !state.expanded[node.path];
            renderFolders();
          });
          name.className = "folderName";
          name.textContent = node.name;
          count.className = "count";
          count.textContent = String(node.totalCount);
          row.appendChild(arrow);
          row.appendChild(name);
          row.appendChild(count);
          container.appendChild(row);

          if (hasChildren && state.expanded[node.path]) {
            node.children.forEach(function (child) { container.appendChild(renderFolderNode(child)); });
          }

          return container;
        }

        function renderFolders() {
          if (!state.folderRoot) return;
          els.folderTree.innerHTML = "";
          els.folderTree.appendChild(renderFolderNode(state.folderRoot));
          els.folderMeta.textContent = String(Math.max(Object.keys(state.folderIndex).length - 1, 0));
        }

        function renderTemplates() {
          var visible = visibleTemplates();
          if (!visible.some(function (template) { return template.id === state.selectedId; })) {
            state.selectedId = visible[0] ? visible[0].id : "";
          }

          els.listTitle.textContent = state.query ? "Search results" : (state.selectedFolder || "All templates");
          els.listMeta.textContent = String(visible.length);
          els.templateList.innerHTML = "";

          if (!visible.length) {
            els.templateList.innerHTML = '<div class="empty">No templates found.</div>';
            return;
          }

          visible.forEach(function (template) {
            var row = document.createElement("button");
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
              '<span class="title">' + escapeHtml(template.title || "Untitled template") + '</span>';
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

        async function insertSelectedTemplate() {
          markComposeReady();
          var template = selectedTemplate();
          var office = window.Office;
          var item = office && office.context && office.context.mailbox && office.context.mailbox.item;

          if (!template) return;
          if (!state.composeReady) {
            notice("Open New mail, then double click a template to insert.", "error");
            return;
          }

          notice("Inserting...", "");
          try {
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
          try {
            var response = await fetch(TEMPLATE_API_URL, { cache: "no-store" });
            if (!response.ok) throw new Error("Template API returned " + response.status + ".");
            var data = await response.json();
            state.templates = Array.isArray(data.templates) ? data.templates.map(normaliseTemplate) : [];
            state.templates.sort(function (a, b) { return a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title); });
            var built = buildFolderTree(state.templates);
            state.folderRoot = built.root;
            state.folderIndex = built.index;
            state.selectedFolder = chooseInitialFolder();
            expandPath(state.selectedFolder);
            state.selectedId = visibleTemplates()[0] ? visibleTemplates()[0].id : "";
            notice("", "");
            render();
          } catch (error) {
            els.folderTree.innerHTML = '<div class="empty">Could not load folders.</div>';
            els.templateList.innerHTML = '<div class="empty">' + escapeHtml(error && error.message ? error.message : "Could not load templates.") + '</div>';
          }
        }

        els.search.addEventListener("input", function () {
          state.query = els.search.value.trim().toLowerCase();
          state.selectedId = visibleTemplates()[0] ? visibleTemplates()[0].id : "";
          renderTemplates();
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
