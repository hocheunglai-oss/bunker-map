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

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Fratelli Cosulich Templates</title>
    <script src="https://appsforoffice.microsoft.com/lib/1/hosted/office.js"></script>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        font-family: Arial, Helvetica, sans-serif;
        background: #f5f9fc;
        color: #10243a;
      }
      .shell { padding: 16px; }
      .header { display: flex; gap: 10px; align-items: center; margin-bottom: 14px; }
      .header img { width: 44px; height: 44px; object-fit: contain; }
      .eyebrow { font-size: 12px; color: #5a7a98; text-transform: uppercase; font-weight: 700; }
      h1 { margin: 2px 0 0; font-size: 20px; }
      .stack { display: grid; gap: 10px; }
      .search, .field {
        width: 100%;
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid #c3d7e8;
        background: #fff;
        color: #10243a;
        font-size: 14px;
      }
      .button, .linkButton {
        padding: 10px 14px;
        border-radius: 999px;
        border: 1px solid #0f4a7f;
        background: #0f4a7f;
        color: #fff;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        text-decoration: none;
        text-align: center;
      }
      .message { margin: 12px 0; font-size: 13px; color: #41627f; line-height: 1.5; }
      .tree, .preview {
        display: grid;
        gap: 12px;
        background: #fff;
        border: 1px solid #d7e6f2;
        border-radius: 12px;
        padding: 12px;
      }
      .folder {
        padding: 8px 12px;
        font-size: 12px;
        color: #40607c;
        font-weight: 700;
        border-left: 2px solid #d7e6f2;
      }
      .template {
        text-align: left;
        padding: 12px;
        border: 1px solid #edf3f7;
        border-radius: 10px;
        background: #fff;
        cursor: pointer;
      }
      .template.active { background: #eef7ff; }
      .templateTitle { font-size: 13px; font-weight: 700; color: #16324a; }
      .templateSubject { margin-top: 4px; font-size: 12px; color: #5c7893; }
      .sectionTitle { font-size: 13px; color: #40607c; font-weight: 700; margin-bottom: 8px; }
      .placeholderBox {
        margin-bottom: 16px;
        padding-bottom: 14px;
        border-bottom: 1px solid #edf3f7;
      }
      .placeholderHint { font-size: 12px; color: #5c7893; line-height: 1.5; }
      .checkboxRow { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 13px; color: #35526d; }
      .placeholderLabel { font-size: 12px; color: #5c7893; margin-bottom: 4px; font-weight: 700; }
      .subjectPreview { font-size: 13px; color: #10243a; margin-bottom: 8px; }
      .hidden { display: none; }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="header">
        <img src="${escapeHtml(baseUrl)}/uno-transparent.png" alt="Fratelli Cosulich" />
        <div>
          <div class="eyebrow">Shared Library</div>
          <h1>Email Templates</h1>
        </div>
      </div>

      <div class="stack" style="margin-bottom: 14px;">
        <input id="search" class="search" placeholder="Search templates" />
        <button id="insertButton" class="button" type="button">Insert into email</button>
        <a class="linkButton" href="${escapeHtml(baseUrl)}/admin/emailtemplates" target="_blank" rel="noreferrer">Manage templates</a>
      </div>

      <div id="message" class="message">Loading templates...</div>
      <div id="tree" class="tree"></div>
      <div id="preview" class="preview hidden"></div>
    </div>

    <script>
      (function () {
        const state = {
          templates: [],
          filteredTemplates: [],
          selectedId: "",
          usePlaceholders: false,
          placeholderValues: {},
          officeReady: false,
        };

        const searchInput = document.getElementById("search");
        const insertButton = document.getElementById("insertButton");
        const messageEl = document.getElementById("message");
        const treeEl = document.getElementById("tree");
        const previewEl = document.getElementById("preview");

        function setMessage(text) {
          messageEl.textContent = text || "";
        }

        function normaliseTemplate(input) {
          return {
            id: String(input && input.id || ""),
            title: String(input && input.title || "Untitled template"),
            subject: String(input && input.subject || ""),
            folder: String(input && input.folder || ""),
            bodyHtml: String(input && input.bodyHtml || "<p></p>"),
            bodyText: String(input && input.bodyText || ""),
            tags: Array.isArray(input && input.tags) ? input.tags.map(String) : [],
            placeholders: Array.isArray(input && input.placeholders) ? input.placeholders.map(String) : [],
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

        function buildFolderTree(templates) {
          const root = { name: "root", path: "", children: [], templates: [] };
          templates.forEach((template) => {
            const parts = (template.folder || "General")
              .split("/")
              .map((part) => part.trim())
              .filter(Boolean);
            let node = root;
            parts.forEach((part) => {
              const nextPath = node.path ? node.path + " / " + part : part;
              let child = node.children.find((entry) => entry.name === part && entry.path === nextPath);
              if (!child) {
                child = { name: part, path: nextPath, children: [], templates: [] };
                node.children.push(child);
              }
              node = child;
            });
            node.templates.push(template);
          });

          function sortNode(node) {
            node.children.sort((a, b) => a.name.localeCompare(b.name));
            node.templates.sort((a, b) => a.title.localeCompare(b.title));
            node.children.forEach(sortNode);
            return node;
          }

          return sortNode(root);
        }

        function getSelectedTemplate() {
          return state.templates.find((template) => template.id === state.selectedId) || null;
        }

        function applyPlaceholderValues(content) {
          const template = getSelectedTemplate();
          if (!template || !state.usePlaceholders) return content;
          return String(content).replace(/\\{\\{\\s*([a-zA-Z0-9_.-]+)\\s*\\}\\}/g, function (fullMatch, token) {
            const value = state.placeholderValues[token];
            return value && value.trim().length > 0 ? value : fullMatch;
          });
        }

        function renderFolderNode(node, depth) {
          const wrapper = document.createElement("div");
          wrapper.className = "stack";
          wrapper.style.gap = "8px";

          if (node.path) {
            const folder = document.createElement("div");
            folder.className = "folder";
            folder.style.marginLeft = (depth * 10) + "px";
            folder.textContent = node.name;
            wrapper.appendChild(folder);
          }

          node.templates.forEach((template) => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "template" + (template.id === state.selectedId ? " active" : "");
            button.style.marginLeft = ((depth + (node.path ? 1 : 0)) * 10) + "px";
            button.addEventListener("click", function () {
              state.selectedId = template.id;
              state.usePlaceholders = false;
              state.placeholderValues = {};
              render();
            });

            const title = document.createElement("div");
            title.className = "templateTitle";
            title.textContent = template.title;
            const subject = document.createElement("div");
            subject.className = "templateSubject";
            subject.textContent = template.subject || "No subject";

            button.appendChild(title);
            button.appendChild(subject);
            wrapper.appendChild(button);
          });

          node.children.forEach((child) => {
            wrapper.appendChild(renderFolderNode(child, depth + 1));
          });

          return wrapper;
        }

        function renderPreview() {
          const template = getSelectedTemplate();
          previewEl.innerHTML = "";

          if (!template) {
            previewEl.classList.add("hidden");
            return;
          }

          previewEl.classList.remove("hidden");

          if (template.placeholders.length > 0) {
            const placeholderBox = document.createElement("div");
            placeholderBox.className = "placeholderBox";

            const checkboxRow = document.createElement("label");
            checkboxRow.className = "checkboxRow";
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = state.usePlaceholders;
            checkbox.addEventListener("change", function () {
              state.usePlaceholders = checkbox.checked;
              render();
            });
            checkboxRow.appendChild(checkbox);
            checkboxRow.appendChild(document.createTextNode("Use optional placeholders"));
            placeholderBox.appendChild(checkboxRow);

            if (state.usePlaceholders) {
              template.placeholders.forEach((token) => {
                const label = document.createElement("label");
                const title = document.createElement("div");
                title.className = "placeholderLabel";
                title.textContent = "{{" + token + "}}";
                const input = document.createElement("input");
                input.className = "field";
                input.placeholder = "Leave blank to keep token unchanged";
                input.value = state.placeholderValues[token] || "";
                input.addEventListener("input", function () {
                  state.placeholderValues[token] = input.value;
                  renderPreview();
                });
                label.appendChild(title);
                label.appendChild(input);
                placeholderBox.appendChild(label);
              });
            } else {
              const hint = document.createElement("div");
              hint.className = "placeholderHint";
              hint.textContent = "This template includes optional placeholders. Leave this off to insert the original template exactly as saved.";
              placeholderBox.appendChild(hint);
            }

            previewEl.appendChild(placeholderBox);
          }

          const previewTitle = document.createElement("div");
          previewTitle.className = "sectionTitle";
          previewTitle.textContent = "Preview";
          previewEl.appendChild(previewTitle);

          const subject = document.createElement("div");
          subject.className = "subjectPreview";
          subject.innerHTML = "<strong>Subject:</strong> " + escapeHtml(applyPlaceholderValues(template.subject || "(blank)"));
          previewEl.appendChild(subject);

          const body = document.createElement("div");
          body.style.fontSize = "13px";
          body.style.lineHeight = "1.5";
          body.style.color = "#10243a";
          body.innerHTML = applyPlaceholderValues(template.bodyHtml || "<p></p>");
          previewEl.appendChild(body);

          insertButton.textContent = state.usePlaceholders && template.placeholders.length
            ? "Insert with chosen values"
            : "Insert into email";
        }

        function render() {
          const keyword = searchInput.value.trim().toLowerCase();
          state.filteredTemplates = state.templates.filter((template) => {
            if (!keyword) return true;
            return [template.title, template.subject, template.folder, template.bodyText].join(" ").toLowerCase().includes(keyword);
          });

          const tree = buildFolderTree(state.filteredTemplates);
          treeEl.innerHTML = "";
          treeEl.appendChild(renderFolderNode(tree, 0));
          renderPreview();
        }

        async function insertTemplate() {
          const office = window.Office;
          const template = getSelectedTemplate();
          if (!state.officeReady || !office || !office.context || !office.context.mailbox || !office.context.mailbox.item || !template) {
            setMessage("Open this add-in while composing an Outlook email.");
            return;
          }

          const item = office.context.mailbox.item;
          setMessage("Inserting template...");

          const subject = applyPlaceholderValues(template.subject || "");
          const htmlBody = applyPlaceholderValues(template.bodyHtml || "");
          const textBody = applyPlaceholderValues(template.bodyText || "");

          item.subject.setAsync(subject, function (subjectResult) {
            if (subjectResult.status !== office.AsyncResultStatus.Succeeded) {
              setMessage("Subject insert failed: " + ((subjectResult.error && subjectResult.error.message) || "Unknown error."));
              return;
            }

            item.body.getTypeAsync(function (typeResult) {
              if (typeResult.status !== office.AsyncResultStatus.Succeeded) {
                setMessage("Body type check failed: " + ((typeResult.error && typeResult.error.message) || "Unknown error."));
                return;
              }

              const isHtml = typeResult.value === office.MailboxEnums.BodyType.Html;
              const content = isHtml ? htmlBody : textBody;
              const options = isHtml
                ? { coercionType: office.CoercionType.Html }
                : { coercionType: office.CoercionType.Text };

              item.body.setSelectedDataAsync(content, options, function (bodyResult) {
                if (bodyResult.status !== office.AsyncResultStatus.Succeeded) {
                  setMessage("Body insert failed: " + ((bodyResult.error && bodyResult.error.message) || "Unknown error."));
                  return;
                }

                setMessage('Inserted "' + template.title + '".');
              });
            });
          });
        }

        async function init() {
          try {
            const response = await fetch("${escapeHtml(baseUrl)}/api/email-templates", { cache: "no-store" });
            if (!response.ok) throw new Error("Could not load shared templates.");
            const data = await response.json();
            state.templates = Array.isArray(data.templates) ? data.templates.map(normaliseTemplate) : [];
            state.selectedId = state.templates[0] ? state.templates[0].id : "";
            setMessage("");
            render();
          } catch (error) {
            setMessage(error && error.message ? error.message : "Could not load shared templates.");
          }
        }

        insertButton.addEventListener("click", insertTemplate);
        searchInput.addEventListener("input", render);

        if (window.Office && typeof window.Office.onReady === "function") {
          window.Office.onReady(function () {
            state.officeReady = true;
            init();
          });
        } else {
          setMessage("Office.js is loaded outside the Office client.");
          init();
        }
      })();
    </script>
  </body>
</html>`

  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, max-age=0",
    },
  })
}
