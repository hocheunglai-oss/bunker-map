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
      html { min-height: 100%; background: #f4f6f8; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Arial, Helvetica, sans-serif;
        background: #f4f6f8;
        color: #172534;
      }
      button, input { font: inherit; }
      .app {
        min-height: 100vh;
        display: flex;
        flex-direction: column;
      }
      .topbar {
        position: sticky;
        top: 0;
        z-index: 5;
        display: grid;
        grid-template-columns: 38px minmax(0, 1fr) 36px;
        gap: 10px;
        align-items: center;
        padding: 12px 12px 10px;
        background: #ffffff;
        border-bottom: 1px solid #d9e2ea;
      }
      .logo {
        width: 38px;
        height: 38px;
        object-fit: contain;
      }
      .kicker {
        font-size: 11px;
        line-height: 1.2;
        font-weight: 700;
        color: #6a7885;
        text-transform: uppercase;
      }
      h1 {
        margin: 1px 0 0;
        font-size: 18px;
        line-height: 1.2;
        letter-spacing: 0;
        color: #11263b;
      }
      .iconButton {
        width: 34px;
        height: 34px;
        display: grid;
        place-items: center;
        border: 1px solid #c8d5df;
        border-radius: 7px;
        background: #f8fafc;
        color: #24384c;
        cursor: pointer;
      }
      .iconButton:hover { background: #edf4f8; }
      .content {
        display: grid;
        gap: 10px;
        padding: 10px;
        padding-bottom: 154px;
      }
      .searchWrap {
        position: sticky;
        top: 61px;
        z-index: 4;
        display: grid;
        gap: 8px;
        padding: 10px;
        border: 1px solid #dbe4ec;
        border-radius: 8px;
        background: #ffffff;
        box-shadow: 0 8px 20px rgba(32, 55, 74, 0.06);
      }
      .search {
        width: 100%;
        height: 36px;
        padding: 0 10px;
        border: 1px solid #c4d0da;
        border-radius: 7px;
        background: #ffffff;
        color: #172534;
        outline: none;
      }
      .search:focus {
        border-color: #1672b9;
        box-shadow: 0 0 0 3px rgba(22, 114, 185, 0.13);
      }
      .statusRow {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        align-items: center;
      }
      .pill {
        min-height: 24px;
        display: inline-flex;
        align-items: center;
        gap: 5px;
        padding: 4px 8px;
        border: 1px solid #d3dee7;
        border-radius: 999px;
        background: #f7fafc;
        color: #445667;
        font-size: 11px;
        font-weight: 700;
      }
      .pill.ready { border-color: #b8ddc9; background: #eef8f2; color: #1d6a3b; }
      .pill.warn { border-color: #efd89d; background: #fff8e6; color: #7a5715; }
      .pill.error { border-color: #efb3b3; background: #fff0f0; color: #9c2727; }
      .section {
        border: 1px solid #dbe4ec;
        border-radius: 8px;
        background: #ffffff;
        overflow: hidden;
      }
      .sectionHeader {
        display: flex;
        justify-content: space-between;
        gap: 8px;
        align-items: center;
        min-height: 36px;
        padding: 9px 10px;
        border-bottom: 1px solid #e4ebf1;
        background: #fbfcfd;
      }
      .sectionTitle {
        min-width: 0;
        font-size: 12px;
        font-weight: 800;
        color: #435565;
        text-transform: uppercase;
      }
      .sectionMeta {
        color: #697987;
        font-size: 11px;
        white-space: nowrap;
      }
      .folderTree {
        max-height: 232px;
        overflow: auto;
        padding: 6px;
      }
      .folderRow {
        width: 100%;
        min-height: 30px;
        display: grid;
        grid-template-columns: 18px minmax(0, 1fr) auto;
        gap: 4px;
        align-items: center;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: #203246;
        text-align: left;
        cursor: pointer;
      }
      .folderRow:hover { background: #f0f5f8; }
      .folderRow.active { background: #dff0fb; color: #0c4774; }
      .folderToggle {
        width: 18px;
        height: 22px;
        border: 0;
        background: transparent;
        color: inherit;
        cursor: pointer;
        padding: 0;
      }
      .folderName {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 12px;
        font-weight: 700;
      }
      .folderCount {
        min-width: 24px;
        padding: 2px 6px;
        border-radius: 999px;
        background: #eef3f7;
        color: #586a7b;
        font-size: 11px;
        font-weight: 700;
        text-align: center;
      }
      .folderRow.active .folderCount { background: #ffffff; color: #0c4774; }
      .templatesList {
        max-height: 310px;
        overflow: auto;
        padding: 6px;
      }
      .templateCard {
        width: 100%;
        display: grid;
        gap: 4px;
        margin-bottom: 6px;
        padding: 10px;
        border: 1px solid #e2e9ef;
        border-radius: 7px;
        background: #ffffff;
        color: #1b2d40;
        text-align: left;
        cursor: pointer;
      }
      .templateCard:hover { border-color: #b9ccda; background: #fbfdff; }
      .templateCard.active {
        border-color: #2c86c6;
        background: #eef7ff;
      }
      .templateTitle {
        overflow-wrap: anywhere;
        font-size: 13px;
        font-weight: 800;
        line-height: 1.3;
      }
      .templateSubject {
        overflow-wrap: anywhere;
        font-size: 12px;
        line-height: 1.35;
        color: #526679;
      }
      .templatePath {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 11px;
        color: #7c8b98;
      }
      .preview {
        display: grid;
        gap: 10px;
        padding: 10px;
      }
      .previewSubject {
        padding: 9px;
        border: 1px solid #e1e8ef;
        border-radius: 7px;
        background: #f8fafc;
        font-size: 12px;
        line-height: 1.4;
        overflow-wrap: anywhere;
      }
      .recipientLine {
        display: none;
        padding: 8px 9px;
        border-left: 3px solid #e7c15d;
        background: #fff8e6;
        color: #5b4818;
        font-size: 11px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .recipientLine.visible { display: block; }
      .placeholderPanel {
        display: none;
        border: 1px solid #dce6ee;
        border-radius: 7px;
        background: #fbfcfd;
        overflow: hidden;
      }
      .placeholderPanel.visible { display: block; }
      .placeholderTop {
        display: flex;
        align-items: center;
        gap: 7px;
        padding: 8px 9px;
        border-bottom: 1px solid #e5ebf1;
        font-size: 12px;
        font-weight: 700;
        color: #394b5b;
      }
      .placeholderFields {
        display: grid;
        gap: 7px;
        padding: 9px;
      }
      .placeholderFields.hidden { display: none; }
      .fieldLabel {
        display: grid;
        gap: 4px;
        color: #586a7b;
        font-size: 11px;
        font-weight: 700;
      }
      .field {
        width: 100%;
        min-height: 32px;
        padding: 0 8px;
        border: 1px solid #cbd8e2;
        border-radius: 6px;
        background: #ffffff;
        color: #172534;
      }
      .placeholderHint {
        padding: 0 9px 9px;
        color: #6c7d8c;
        font-size: 11px;
        line-height: 1.45;
      }
      .bodyPreview {
        max-height: 360px;
        overflow: auto;
        padding: 10px;
        border: 1px solid #e1e8ef;
        border-radius: 7px;
        background: #ffffff;
        color: #172534;
        font-size: 12px;
        line-height: 1.45;
      }
      .bodyPreview table { max-width: 100%; }
      .bodyPreview img { max-width: 100%; height: auto; }
      .empty {
        padding: 18px 12px;
        color: #617487;
        font-size: 12px;
        line-height: 1.55;
      }
      .footer {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 6;
        display: grid;
        gap: 8px;
        padding: 10px;
        border-top: 1px solid #d5e0e9;
        background: #ffffff;
        box-shadow: 0 -10px 26px rgba(22, 39, 55, 0.1);
      }
      .options {
        display: flex;
        flex-wrap: wrap;
        gap: 8px 12px;
        align-items: center;
      }
      .checkOption {
        display: inline-flex;
        align-items: center;
        gap: 5px;
        color: #4a5c6d;
        font-size: 11px;
        font-weight: 700;
      }
      .checkOption.hidden { display: none; }
      .primary {
        width: 100%;
        min-height: 40px;
        border: 1px solid #0c609b;
        border-radius: 7px;
        background: #0f6fac;
        color: #ffffff;
        font-size: 13px;
        font-weight: 800;
        cursor: pointer;
      }
      .primary:disabled {
        border-color: #c4d0da;
        background: #e7edf2;
        color: #7c8995;
        cursor: not-allowed;
      }
      .toast {
        min-height: 22px;
        color: #526679;
        font-size: 11px;
        line-height: 1.35;
      }
      .toast.error { color: #a12a2a; }
      .toast.success { color: #1d6a3b; }
      @media (min-width: 560px) {
        .content {
          grid-template-columns: 260px minmax(0, 1fr);
          align-items: start;
        }
        .searchWrap { grid-column: 1 / -1; }
        .previewSection { grid-column: 2; }
        .folderTree { max-height: calc(100vh - 250px); }
        .templatesList { max-height: calc(100vh - 250px); }
      }
    </style>
  </head>
  <body>
    <div class="app">
      <header class="topbar">
        <img class="logo" src="${escapeHtml(baseUrl)}/outlook-template-icon-32.png" alt="Fratelli Cosulich" />
        <div>
          <div class="kicker">Shared Library</div>
          <h1>Email Templates</h1>
        </div>
        <button id="reloadButton" class="iconButton" type="button" title="Reload templates" aria-label="Reload templates">↻</button>
      </header>

      <main class="content">
        <section class="searchWrap" aria-label="Search and status">
          <input id="searchInput" class="search" type="search" placeholder="Search subject, folder, or body" autocomplete="off" />
          <div class="statusRow">
            <span id="libraryStatus" class="pill warn">Loading library</span>
            <span id="officeStatus" class="pill warn">Checking Outlook</span>
            <span id="selectionStatus" class="pill">No selection</span>
          </div>
        </section>

        <section class="section">
          <div class="sectionHeader">
            <div class="sectionTitle">Folders</div>
            <div id="folderMeta" class="sectionMeta">0</div>
          </div>
          <div id="folderTree" class="folderTree">
            <div class="empty">Loading Thunderbird folder structure...</div>
          </div>
        </section>

        <section class="section">
          <div class="sectionHeader">
            <div id="listTitle" class="sectionTitle">Templates</div>
            <div id="listMeta" class="sectionMeta">0</div>
          </div>
          <div id="templateList" class="templatesList">
            <div class="empty">Loading templates...</div>
          </div>
        </section>

        <section class="section previewSection">
          <div class="sectionHeader">
            <div class="sectionTitle">Preview</div>
            <div id="previewMeta" class="sectionMeta"></div>
          </div>
          <div id="preview" class="preview">
            <div class="empty">Select a template to preview it.</div>
          </div>
        </section>
      </main>

      <footer class="footer">
        <div class="options">
          <label class="checkOption"><input id="insertSubject" type="checkbox" checked /> Subject</label>
          <label class="checkOption"><input id="insertBody" type="checkbox" checked /> Body</label>
          <label id="recipientOption" class="checkOption hidden"><input id="insertRecipients" type="checkbox" /> Add recipients</label>
        </div>
        <button id="insertButton" class="primary" type="button" disabled>Insert selected template</button>
        <div id="toast" class="toast">Templates can load before Outlook finishes Office.js startup.</div>
      </footer>
    </div>

    <script>
      (function () {
        var TEMPLATE_API_URL = ${JSON.stringify(templatesUrl)};
        var state = {
          templates: [],
          folderRoot: null,
          folderIndex: {},
          expanded: {},
          selectedFolder: "",
          selectedId: "",
          query: "",
          officeReady: false,
          officeChecked: false,
          loading: false,
          error: "",
          usePlaceholders: false,
          placeholderValues: {}
        };

        var els = {
          reloadButton: document.getElementById("reloadButton"),
          searchInput: document.getElementById("searchInput"),
          libraryStatus: document.getElementById("libraryStatus"),
          officeStatus: document.getElementById("officeStatus"),
          selectionStatus: document.getElementById("selectionStatus"),
          folderMeta: document.getElementById("folderMeta"),
          folderTree: document.getElementById("folderTree"),
          listTitle: document.getElementById("listTitle"),
          listMeta: document.getElementById("listMeta"),
          templateList: document.getElementById("templateList"),
          previewMeta: document.getElementById("previewMeta"),
          preview: document.getElementById("preview"),
          insertSubject: document.getElementById("insertSubject"),
          insertBody: document.getElementById("insertBody"),
          insertRecipients: document.getElementById("insertRecipients"),
          recipientOption: document.getElementById("recipientOption"),
          insertButton: document.getElementById("insertButton"),
          toast: document.getElementById("toast")
        };

        function setToast(message, kind) {
          els.toast.textContent = message || "";
          els.toast.className = "toast" + (kind ? " " + kind : "");
        }

        function setPill(el, text, kind) {
          el.textContent = text;
          el.className = "pill" + (kind ? " " + kind : "");
        }

        function normaliseTemplate(input) {
          return {
            id: String(input && input.id || ""),
            title: String(input && input.title || "Untitled template"),
            subject: String(input && input.subject || ""),
            folder: String(input && input.folder || "Unfiled"),
            sourcePath: String(input && input.sourcePath || ""),
            from: String(input && input.from || ""),
            to: String(input && input.to || ""),
            cc: String(input && input.cc || ""),
            bcc: String(input && input.bcc || ""),
            bodyHtml: String(input && input.bodyHtml || "<p></p>"),
            bodyText: String(input && input.bodyText || ""),
            tags: Array.isArray(input && input.tags) ? input.tags.map(String) : [],
            placeholders: Array.isArray(input && input.placeholders) ? input.placeholders.map(String) : []
          };
        }

        function escapeHtml(value) {
          return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
        }

        function getFolderParts(folder) {
          return String(folder || "Unfiled")
            .split(" / ")
            .map(function (part) { return part.trim(); })
            .filter(Boolean);
        }

        function createFolderNode(name, path, depth) {
          return {
            name: name,
            path: path,
            depth: depth,
            children: [],
            templates: [],
            totalCount: 0
          };
        }

        function buildFolderTree(templates) {
          var root = createFolderNode("All templates", "", 0);
          var index = { "": root };

          templates.forEach(function (template) {
            var parts = getFolderParts(template.folder);
            var node = root;
            parts.forEach(function (part, partIndex) {
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

        function folderMatchesSelected(template, folder) {
          if (!folder) return true;
          return template.folder === folder || template.folder.indexOf(folder + " / ") === 0;
        }

        function templateMatchesQuery(template, query) {
          if (!query) return true;
          return [
            template.title,
            template.subject,
            template.folder,
            template.bodyText,
            template.to,
            template.cc,
            template.bcc
          ].join(" ").toLowerCase().indexOf(query) !== -1;
        }

        function getVisibleTemplates() {
          var query = state.query.trim().toLowerCase();
          return state.templates.filter(function (template) {
            if (query) return templateMatchesQuery(template, query);
            return folderMatchesSelected(template, state.selectedFolder);
          });
        }

        function getSelectedTemplate() {
          for (var i = 0; i < state.templates.length; i += 1) {
            if (state.templates[i].id === state.selectedId) return state.templates[i];
          }
          return null;
        }

        function chooseInitialFolder() {
          var preferred = [
            "Outgoing / Bunker",
            "Internal / Outgoing / Bunker",
            "Outgoing / Account",
            "Internal / Bunker",
            "FCBV"
          ];

          for (var i = 0; i < preferred.length; i += 1) {
            if (state.folderIndex[preferred[i]] && state.folderIndex[preferred[i]].totalCount > 0) {
              return preferred[i];
            }
          }

          var paths = Object.keys(state.folderIndex).filter(function (path) {
            return path && state.folderIndex[path].totalCount > 0;
          });
          paths.sort(function (a, b) {
            return state.folderIndex[b].totalCount - state.folderIndex[a].totalCount || a.localeCompare(b);
          });
          return paths[0] || "";
        }

        function expandPath(path) {
          state.expanded[""] = true;
          if (!path) return;
          var parts = getFolderParts(path);
          var current = "";
          parts.forEach(function (part) {
            current = current ? current + " / " + part : part;
            state.expanded[current] = true;
          });
        }

        function applyPlaceholderValues(content) {
          if (!state.usePlaceholders) return String(content || "");
          return String(content || "").replace(/\\{\\{\\s*([a-zA-Z0-9_.-]+)\\s*\\}\\}/g, function (fullMatch, token) {
            var value = state.placeholderValues[token];
            return value && value.trim().length > 0 ? value : fullMatch;
          });
        }

        function hasTemplateRecipients(template) {
          return Boolean(template && (template.to || template.cc || template.bcc));
        }

        function renderStatuses() {
          if (state.loading) {
            setPill(els.libraryStatus, "Loading library", "warn");
          } else if (state.error) {
            setPill(els.libraryStatus, "Library error", "error");
          } else {
            setPill(els.libraryStatus, state.templates.length + " templates", "ready");
          }

          if (state.officeReady) {
            setPill(els.officeStatus, "Outlook compose ready", "ready");
          } else if (state.officeChecked) {
            setPill(els.officeStatus, "Browse only", "warn");
          } else {
            setPill(els.officeStatus, "Checking Outlook", "warn");
          }

          var selected = getSelectedTemplate();
          setPill(els.selectionStatus, selected ? "Selected" : "No selection", selected ? "ready" : "");
          els.insertButton.disabled = !selected;
        }

        function renderFolderNode(node) {
          var container = document.createElement("div");
          var row = document.createElement("button");
          var toggle = document.createElement("button");
          var name = document.createElement("span");
          var count = document.createElement("span");
          var hasChildren = node.children.length > 0;
          var active = state.selectedFolder === node.path && !state.query;

          row.type = "button";
          row.className = "folderRow" + (active ? " active" : "");
          row.style.paddingLeft = Math.min(node.depth * 13, 65) + "px";
          row.addEventListener("click", function () {
            state.query = "";
            els.searchInput.value = "";
            state.selectedFolder = node.path;
            var visible = getVisibleTemplates();
            state.selectedId = visible[0] ? visible[0].id : "";
            state.usePlaceholders = false;
            state.placeholderValues = {};
            expandPath(node.path);
            render();
          });

          toggle.type = "button";
          toggle.className = "folderToggle";
          toggle.textContent = hasChildren ? (state.expanded[node.path] ? "▾" : "▸") : "";
          toggle.addEventListener("click", function (event) {
            event.stopPropagation();
            state.expanded[node.path] = !state.expanded[node.path];
            renderFolders();
          });

          name.className = "folderName";
          name.textContent = node.name;
          count.className = "folderCount";
          count.textContent = String(node.totalCount);

          row.appendChild(toggle);
          row.appendChild(name);
          row.appendChild(count);
          container.appendChild(row);

          if (hasChildren && state.expanded[node.path]) {
            node.children.forEach(function (child) {
              container.appendChild(renderFolderNode(child));
            });
          }

          return container;
        }

        function renderFolders() {
          if (!state.folderRoot) {
            els.folderTree.innerHTML = '<div class="empty">No folder data yet.</div>';
            return;
          }
          els.folderTree.innerHTML = "";
          els.folderTree.appendChild(renderFolderNode(state.folderRoot));
          els.folderMeta.textContent = Object.keys(state.folderIndex).length - 1 + " folders";
        }

        function renderTemplateList() {
          var visible = getVisibleTemplates();
          var selectedStillVisible = visible.some(function (template) { return template.id === state.selectedId; });
          if (!selectedStillVisible) {
            state.selectedId = visible[0] ? visible[0].id : "";
            state.usePlaceholders = false;
            state.placeholderValues = {};
          }

          els.templateList.innerHTML = "";
          els.listTitle.textContent = state.query ? "Search Results" : (state.selectedFolder || "All Templates");
          els.listMeta.textContent = visible.length + " shown";

          if (state.error) {
            els.templateList.innerHTML = '<div class="empty">' + escapeHtml(state.error) + '<br><br>API: ' + escapeHtml(TEMPLATE_API_URL) + '</div>';
            return;
          }

          if (!visible.length) {
            els.templateList.innerHTML = '<div class="empty">No templates match this view. Try another folder or search term.</div>';
            return;
          }

          visible.forEach(function (template) {
            var card = document.createElement("button");
            var title = document.createElement("div");
            var subject = document.createElement("div");
            var path = document.createElement("div");

            card.type = "button";
            card.className = "templateCard" + (template.id === state.selectedId ? " active" : "");
            card.addEventListener("click", function () {
              state.selectedId = template.id;
              state.usePlaceholders = false;
              state.placeholderValues = {};
              renderTemplateList();
              renderPreview();
              renderStatuses();
            });

            title.className = "templateTitle";
            title.textContent = template.title || "Untitled template";
            subject.className = "templateSubject";
            subject.textContent = template.subject || "No subject";
            path.className = "templatePath";
            path.textContent = template.folder || "Unfiled";

            card.appendChild(title);
            card.appendChild(subject);
            card.appendChild(path);
            els.templateList.appendChild(card);
          });
        }

        function renderPlaceholderPanel(template) {
          var panel = document.createElement("div");
          var top = document.createElement("label");
          var checkbox = document.createElement("input");
          var fields = document.createElement("div");
          var hint = document.createElement("div");

          panel.className = "placeholderPanel" + (template.placeholders.length ? " visible" : "");
          if (!template.placeholders.length) return panel;

          top.className = "placeholderTop";
          checkbox.type = "checkbox";
          checkbox.checked = state.usePlaceholders;
          checkbox.addEventListener("change", function () {
            state.usePlaceholders = checkbox.checked;
            renderPreview();
          });
          top.appendChild(checkbox);
          top.appendChild(document.createTextNode("Use optional placeholders"));
          panel.appendChild(top);

          fields.className = "placeholderFields" + (state.usePlaceholders ? "" : " hidden");
          template.placeholders.forEach(function (token) {
            var label = document.createElement("label");
            var caption = document.createElement("span");
            var input = document.createElement("input");
            label.className = "fieldLabel";
            caption.textContent = "{{" + token + "}}";
            input.className = "field";
            input.value = state.placeholderValues[token] || "";
            input.placeholder = "Leave blank to keep token";
            input.addEventListener("input", function () {
              state.placeholderValues[token] = input.value;
              renderPreview();
            });
            label.appendChild(caption);
            label.appendChild(input);
            fields.appendChild(label);
          });
          panel.appendChild(fields);

          hint.className = "placeholderHint";
          hint.textContent = state.usePlaceholders
            ? "Only filled fields are replaced. Blank fields keep the original token."
            : "Off means Outlook inserts the saved Thunderbird template exactly as-is.";
          panel.appendChild(hint);

          return panel;
        }

        function renderPreview() {
          var template = getSelectedTemplate();
          els.preview.innerHTML = "";
          els.previewMeta.textContent = "";

          if (!template) {
            els.preview.innerHTML = '<div class="empty">Select a template to preview it.</div>';
            els.recipientOption.className = "checkOption hidden";
            renderStatuses();
            return;
          }

          var recipientText = [
            template.to ? "To: " + template.to : "",
            template.cc ? "Cc: " + template.cc : "",
            template.bcc ? "Bcc: " + template.bcc : ""
          ].filter(Boolean).join("\\n");

          var subject = document.createElement("div");
          var recipients = document.createElement("div");
          var body = document.createElement("div");

          subject.className = "previewSubject";
          subject.innerHTML = "<strong>Subject:</strong> " + escapeHtml(applyPlaceholderValues(template.subject || "(blank)"));
          els.preview.appendChild(subject);

          recipients.className = "recipientLine" + (recipientText ? " visible" : "");
          recipients.textContent = recipientText;
          els.preview.appendChild(recipients);

          els.preview.appendChild(renderPlaceholderPanel(template));

          body.className = "bodyPreview";
          body.innerHTML = applyPlaceholderValues(template.bodyHtml || "<p></p>");
          els.preview.appendChild(body);

          els.previewMeta.textContent = template.folder || "Unfiled";
          els.recipientOption.className = "checkOption" + (hasTemplateRecipients(template) ? "" : " hidden");
          renderStatuses();
        }

        function render() {
          renderStatuses();
          renderFolders();
          renderTemplateList();
          renderPreview();
        }

        function markOfficeReadyFromContext() {
          var office = window.Office;
          var item = office && office.context && office.context.mailbox && office.context.mailbox.item;
          state.officeReady = Boolean(item && item.body && item.subject);
          state.officeChecked = true;
          renderStatuses();
        }

        function initOffice() {
          var office = window.Office;
          var timeout = window.setTimeout(function () {
            markOfficeReadyFromContext();
            if (!state.officeReady) {
              setToast("Templates are loaded. Open the pane while composing an email to insert.", "error");
            }
          }, 4500);

          if (office && typeof office.onReady === "function") {
            office.onReady(function () {
              window.clearTimeout(timeout);
              markOfficeReadyFromContext();
              setToast(state.officeReady ? "Ready to insert into this draft." : "Browse mode: open a compose draft to insert.", state.officeReady ? "success" : "");
            });
            return;
          }

          window.clearTimeout(timeout);
          markOfficeReadyFromContext();
          if (!state.officeReady) setToast("Templates are loaded. Outlook compose APIs are not available in this view.", "");
        }

        async function loadTemplates() {
          state.loading = true;
          state.error = "";
          renderStatuses();
          setToast("Loading shared templates...", "");

          try {
            var response = await fetch(TEMPLATE_API_URL, { cache: "no-store" });
            if (!response.ok) throw new Error("Template API returned " + response.status + ".");
            var data = await response.json();
            var templates = Array.isArray(data.templates) ? data.templates.map(normaliseTemplate) : [];
            templates.sort(function (a, b) {
              return a.folder.localeCompare(b.folder) || a.title.localeCompare(b.title);
            });

            state.templates = templates;
            var built = buildFolderTree(templates);
            state.folderRoot = built.root;
            state.folderIndex = built.index;
            state.selectedFolder = chooseInitialFolder();
            state.selectedId = "";
            state.query = "";
            state.usePlaceholders = false;
            state.placeholderValues = {};
            state.expanded = { "": true };
            expandPath(state.selectedFolder);
            state.loading = false;

            var visible = getVisibleTemplates();
            state.selectedId = visible[0] ? visible[0].id : "";
            els.searchInput.value = "";
            setToast("Loaded " + templates.length + " templates from the shared library.", "success");
            render();
          } catch (error) {
            state.loading = false;
            state.error = error && error.message ? error.message : "Could not load templates.";
            setToast(state.error, "error");
            render();
          }
        }

        function officeAsync(call) {
          return new Promise(function (resolve, reject) {
            call(function (result) {
              var office = window.Office;
              var succeeded = office && result && result.status === office.AsyncResultStatus.Succeeded;
              if (succeeded) {
                resolve(result.value);
              } else {
                reject(new Error(result && result.error && result.error.message ? result.error.message : "Outlook action failed."));
              }
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

        async function insertTemplate() {
          var template = getSelectedTemplate();
          var office = window.Office;
          var item = office && office.context && office.context.mailbox && office.context.mailbox.item;

          if (!template) {
            setToast("Select a template first.", "error");
            return;
          }

          if (!item || !item.body || !item.subject) {
            setToast("Open this add-in from a new Outlook message, then insert again.", "error");
            markOfficeReadyFromContext();
            return;
          }

          els.insertButton.disabled = true;
          setToast("Inserting template...", "");

          try {
            if (els.insertSubject.checked) {
              await officeAsync(function (done) {
                item.subject.setAsync(applyPlaceholderValues(template.subject || ""), done);
              });
            }

            if (els.insertRecipients.checked && hasTemplateRecipients(template)) {
              await addRecipients(item.to, template.to);
              await addRecipients(item.cc, template.cc);
              await addRecipients(item.bcc, template.bcc);
            }

            if (els.insertBody.checked) {
              var bodyType = await officeAsync(function (done) { item.body.getTypeAsync(done); });
              var isHtml = bodyType === office.MailboxEnums.BodyType.Html;
              var options = {
                coercionType: isHtml ? office.CoercionType.Html : office.CoercionType.Text
              };
              var content = isHtml
                ? applyPlaceholderValues(template.bodyHtml || "")
                : applyPlaceholderValues(template.bodyText || "");

              await officeAsync(function (done) {
                item.body.setSelectedDataAsync(content, options, done);
              });
            }

            setToast('Inserted "' + (template.title || "template") + '".', "success");
          } catch (error) {
            setToast(error && error.message ? error.message : "Insert failed.", "error");
          } finally {
            els.insertButton.disabled = false;
            markOfficeReadyFromContext();
          }
        }

        els.reloadButton.addEventListener("click", loadTemplates);
        els.searchInput.addEventListener("input", function () {
          state.query = els.searchInput.value.trim().toLowerCase();
          if (state.query) {
            state.selectedId = "";
            state.usePlaceholders = false;
            state.placeholderValues = {};
          }
          renderTemplateList();
          renderPreview();
        });
        els.insertButton.addEventListener("click", insertTemplate);
        els.insertSubject.addEventListener("change", renderStatuses);
        els.insertBody.addEventListener("change", renderStatuses);
        els.insertRecipients.addEventListener("change", renderStatuses);

        loadTemplates();
        initOffice();
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
