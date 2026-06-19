import * as vscode from "vscode";
import * as path from "node:path";

function getNonce(): string {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) text += possible.charAt(Math.floor(Math.random() * possible.length));
  return text;
}

export function getHtml(
  webview: vscode.Webview,
  context: vscode.ExtensionContext,
  chatFontScale: () => number,
  extVersion: string
): string {
  const nonce = getNonce();
  const mediaUri = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "media", file));
  const resourceUri = (file: string) =>
    webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, "resources", file));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data:; media-src ${webview.cspSource} data:; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
<link rel="stylesheet" href="${mediaUri("chat.css")}" />
</head>
<body style="--chat-zoom: ${chatFontScale()}">

  <header class="top-bar">
    <button id="history-btn" class="toolbar-btn" title="Session history"></button>
    <button id="new-btn" class="toolbar-btn" title="New session"></button>
    <div id="history-popover" class="toolbar-popover history-popover" hidden></div>
  </header>

  <main id="messages" class="messages">
    <div class="welcome" id="welcome">
      <img src="${resourceUri("grok-mark-light.svg")}" alt="Grok" class="welcome-mark" />
      <h2>Grok Build</h2>
      <p class="welcome-byline muted">by Paweł Huryn (<a href="https://www.productcompass.pm" class="muted-link">productcompass.pm</a>)</p>
      <p id="welcome-version" class="muted loading-dots">Starting</p>
      <div id="welcome-onboarding"></div>
    </div>
  </main>

  <footer class="composer">
    <div class="composer-input-wrap">
      <div id="input-highlight" class="input-highlight" aria-hidden="true"></div>
      <textarea id="input" placeholder="Ask Grok..." rows="3"></textarea>
    </div>
    <button id="mic-btn" class="mic-btn" title="Voice input"></button>
    <div class="composer-toolbar">
      <div class="toolbar-left">
        <button id="add-btn" class="toolbar-btn" title="Add context"></button>
        <button id="gear-btn" class="toolbar-btn" title="Settings"></button>
        <div class="context-donut" id="donut" title="Context usage">
          <svg width="16" height="16" viewBox="0 0 16 16">
            <circle cx="8" cy="8" r="5" fill="none" stroke="var(--vscode-editorWidget-border,#444)" stroke-width="3"/>
            <circle id="donut-arc" cx="8" cy="8" r="5" fill="none" stroke="var(--vscode-charts-green,#4ec9b0)" stroke-width="3" stroke-dasharray="0 999" transform="rotate(-90 8 8)"/>
          </svg>
          <span id="donut-label" class="small muted">0%</span>
        </div>
        <div id="chips"></div>
      </div>
      <div class="toolbar-right">
        <button id="mode-btn" class="toolbar-btn" title="Pick mode"></button>
        <button id="send-btn" class="send"></button>
      </div>
    </div>
    <div id="mode-popover" class="toolbar-popover" hidden></div>
    <div id="gear-popover" class="toolbar-popover gear-popover" hidden></div>
    <div id="add-popover" class="toolbar-popover" hidden></div>
    <div id="slash-popover" class="slash-popover" hidden></div>
  </footer>

  <script nonce="${nonce}">
    // Configure MathJax before its bundle loads...
    window.MathJax = {
      tex: { processEnvironments: true, processRefs: true },
      svg: { fontCache: "local" },
      options: { enableMenu: false, enableAssistiveMml: false },
      startup: { typeset: false }
    };
  </script>
  <script nonce="${nonce}" src="${mediaUri("mathjax/tex-svg-full.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("mermaid/mermaid.min.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("webview-helpers.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("markdown.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("popovers.js")}"></script>
  <script nonce="${nonce}" src="${mediaUri("chat.js")}"></script>
</body>
</html>`;
}

export { getNonce };
