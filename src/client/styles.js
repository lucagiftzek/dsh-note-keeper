/**
 * Note Keeper styles, built only from the tzekos.eu design tokens that
 * dsh-tzekos-theme publishes (with fallbacks, so the plugin also renders on a
 * stock DSH theme): warm near-black / paper surfaces through the dsw alias
 * ramp (dark + light modes for free), clay accent, steel-blue secondary,
 * square corners, 1px lines, hard offset shadows, Silkscreen display labels.
 */
export const NK_CSS = `
.nk-root{--nk-bg:var(--dsw-alias-bg-primary,#131110);--nk-bg2:var(--dsw-alias-bg-secondary,#1b1817);--nk-bg3:var(--dsw-alias-bg-tertiary,#2a2523);
  --nk-fg:var(--dsw-alias-label-primary,#f4f0ed);--nk-fg2:var(--dsw-alias-label-secondary,#c0b7b2);--nk-fg3:var(--dsw-alias-label-tertiary,#9a928e);
  --nk-line:var(--dsw-alias-border-primary,#3a332f);--nk-accent:var(--tz-accent,#c1553a);--nk-accent2:var(--tz-accent-2,#5e9bd6);--nk-accent-2:var(--nk-accent2);--nk-text:var(--tz-font-text,var(--dsw-font-sans,"Inter",system-ui,sans-serif));
  --nk-on-accent:var(--tz-on-accent,#fbf7f4);--nk-shadow:var(--tz-shadow-pop,6px 6px 0 rgba(0,0,0,.45));
  --nk-display:var(--tz-font-display,"Silkscreen",ui-monospace,monospace);--nk-mono:var(--tz-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);
  --nk-ok:var(--dsw-alias-state-success-primary,#4f9d69);--nk-err:var(--dsw-alias-state-error-primary,#e0685a);--nk-warn:var(--dsw-alias-state-warn-primary,#c8952f);
  position:relative;display:flex;flex-direction:column;height:100%;min-height:0;width:100%;background:var(--nk-bg);color:var(--nk-fg);font-size:14px;line-height:1.5;container-type:inline-size;container-name:nk}
.nk-root *{box-sizing:border-box;border-radius:0}
.nk-root button{font:inherit;color:inherit}
.nk-head{display:flex;align-items:center;gap:10px;padding:10px 96px 10px 14px;border-bottom:1px solid var(--nk-line);background:var(--nk-bg2);flex:none;flex-wrap:wrap}
.nk-brand{font-family:var(--nk-display);font-size:13px;letter-spacing:.08em;text-transform:uppercase;display:flex;align-items:center;gap:8px;white-space:nowrap}
.nk-brand i{width:10px;height:10px;background:var(--nk-accent);display:inline-block;box-shadow:2px 2px 0 var(--nk-accent2)}
.nk-vault{font-family:var(--nk-mono);font-size:11px;color:var(--nk-fg3)}
.nk-spacer{flex:1}
.nk-btn{display:inline-flex;align-items:center;gap:6px;padding:5px 10px;border:1px solid var(--nk-line);background:var(--nk-bg);cursor:pointer;font-size:12.5px;white-space:nowrap;transition:transform .06s}
.nk-btn:hover{border-color:var(--nk-accent);color:var(--nk-fg)}
.nk-btn:active{transform:translate(1px,1px)}
.nk-btn:disabled{opacity:.45;cursor:default}
.nk-btn.nk-primary{background:var(--nk-accent);border-color:var(--nk-accent);color:var(--nk-on-accent);box-shadow:0 2px 0 color-mix(in srgb,var(--nk-accent) 55%,#000)}
.nk-btn.nk-danger{border-color:var(--nk-err);color:var(--nk-err)}
.nk-btn.nk-on{border-color:var(--nk-accent);background:color-mix(in srgb,var(--nk-accent) 18%,transparent)}
.nk-ibtn{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid transparent;background:none;cursor:pointer;color:var(--nk-fg2)}
.nk-ibtn:hover{border-color:var(--nk-line);color:var(--nk-fg)}
.nk-input{background:var(--nk-bg);border:1px solid var(--nk-line);color:var(--nk-fg);padding:6px 9px;font:inherit;outline:none;min-width:0}
.nk-input:focus{border-color:var(--nk-accent)}
.nk-search{width:260px;max-width:40vw}
.nk-body{flex:1;min-height:0;display:grid;grid-template-columns:260px minmax(0,1fr) 250px}
.nk-body.nk-no-info{grid-template-columns:260px minmax(0,1fr)}
.nk-side{border-right:1px solid var(--nk-line);background:var(--nk-bg2);display:flex;flex-direction:column;min-height:0}
.nk-info{border-left:1px solid var(--nk-line);background:var(--nk-bg2);overflow:auto;padding:12px;min-height:0}
.nk-tabs{display:flex;border-bottom:1px solid var(--nk-line);flex:none}
.nk-tab{flex:1;padding:7px 4px;border:none;background:none;cursor:pointer;font-family:var(--nk-display);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--nk-fg3);border-bottom:2px solid transparent}
.nk-tab.nk-on{color:var(--nk-fg);border-bottom-color:var(--nk-accent)}
.nk-sidebody{flex:1;overflow:auto;min-height:0;padding:6px 0}
.nk-sidefoot{border-top:1px solid var(--nk-line);padding:6px;display:flex;gap:4px;flex-wrap:wrap;flex:none}
.nk-row{display:flex;align-items:center;gap:6px;padding:3px 8px 3px calc(8px + var(--d,0) * 14px);cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;color:var(--nk-fg2);border-left:2px solid transparent;user-select:none}
.nk-row:hover{background:color-mix(in srgb,var(--nk-fg) 6%,transparent);color:var(--nk-fg)}
.nk-row.nk-sel{border-left-color:var(--nk-accent);background:color-mix(in srgb,var(--nk-accent) 14%,transparent);color:var(--nk-fg)}
.nk-row.nk-drop{outline:1px dashed var(--nk-accent);outline-offset:-2px}
.nk-row .nk-ico{flex:none;width:14px;display:inline-flex;justify-content:center;color:var(--nk-fg3)}
.nk-row .nk-name{overflow:hidden;text-overflow:ellipsis}
.nk-row .nk-badge{margin-left:auto;font-size:10px;color:var(--nk-fg3);font-family:var(--nk-mono)}
.nk-lockico{color:var(--nk-warn)}
.nk-main{display:flex;flex-direction:column;min-width:0;min-height:0}
.nk-empty{margin:auto;text-align:center;color:var(--nk-fg3);padding:30px;max-width:560px}
.nk-empty h2{font-family:var(--nk-display);font-weight:400;font-size:16px;color:var(--nk-fg);letter-spacing:.06em}
.nk-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;margin-top:18px;text-align:left}
.nk-card{border:1px solid var(--nk-line);background:var(--nk-bg2);padding:12px;cursor:pointer}
.nk-card:hover{border-color:var(--nk-accent);box-shadow:var(--nk-shadow)}
.nk-card b{display:block;font-family:var(--nk-display);font-size:11px;font-weight:400;letter-spacing:.06em;text-transform:uppercase;color:var(--nk-fg);margin-bottom:4px}
.nk-card span{font-size:12px}
.nk-notehead{display:flex;align-items:center;gap:8px;padding:8px 14px;border-bottom:1px solid var(--nk-line);flex:none;flex-wrap:wrap}
.nk-title{flex:1;min-width:120px;font-size:18px;font-weight:600;background:none;border:1px solid transparent;color:var(--nk-fg);padding:3px 6px}
.nk-title:focus{border-color:var(--nk-line);outline:none}
.nk-path{font-family:var(--nk-mono);font-size:11px;color:var(--nk-fg3)}
.nk-toolbar{display:flex;gap:2px;padding:4px 10px;border-bottom:1px solid var(--nk-line);flex:none;flex-wrap:wrap;align-items:center}
.nk-sep{width:1px;height:18px;background:var(--nk-line);margin:0 4px}
.nk-editwrap{flex:1;min-height:0;display:grid;grid-template-columns:1fr}
.nk-editwrap.nk-split{grid-template-columns:1fr 1fr}
.nk-cm{min-height:0;height:100%;overflow:hidden;background:var(--nk-bg)}
.nk-split .nk-cm{border-right:1px solid var(--nk-line)}
.nk-cm .cm-editor{height:100%;background:var(--nk-bg);color:var(--nk-fg)}
.nk-cm .cm-editor.cm-focused{outline:none}
.nk-cm .cm-scroller{font-family:var(--nk-mono);font-size:13.5px;line-height:1.7;overflow:auto}
.nk-cm .cm-content{padding:18px 22px 40vh;max-width:860px;caret-color:var(--nk-accent)}
.nk-cm .cm-editor.nk-cm-live .cm-scroller{font-family:var(--nk-text);font-size:15px;line-height:1.7}
.nk-cm .cm-line{padding:0}
.nk-cm .cm-activeLine{background:color-mix(in srgb,var(--nk-fg) 4%,transparent)}
.nk-cm .cm-selectionBackground,.nk-cm .cm-editor.cm-focused .cm-selectionBackground{background:color-mix(in srgb,var(--nk-accent) 28%,transparent) !important}
.nk-cm .cm-cursor{border-left:2px solid var(--nk-accent)}
.nk-cm .cm-placeholder{color:var(--nk-fg3)}
.nk-cm .nk-cm-h{font-weight:700;color:var(--nk-fg)}
.nk-cm .nk-cm-live .nk-cm-h1{font-size:1.75em;line-height:1.3;padding-top:.4em}
.nk-cm .nk-cm-live .nk-cm-h2{font-size:1.45em;line-height:1.35;padding-top:.35em}
.nk-cm .nk-cm-live .nk-cm-h3{font-size:1.2em}
.nk-cm .nk-cm-live .nk-cm-h4,.nk-cm .nk-cm-live .nk-cm-h5,.nk-cm .nk-cm-live .nk-cm-h6{font-size:1.05em}
.nk-cm-wikilink,.nk-cm-link{color:var(--nk-accent);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;cursor:pointer}
.nk-cm-source .nk-cm-wikilink,.nk-cm-source .nk-cm-link{cursor:text}
.nk-cm-wikilink.nk-unresolved{color:var(--nk-fg3);text-decoration-style:dashed}
.nk-cm-wikilink-raw,.nk-cm-link-raw{color:var(--nk-accent)}
.nk-cm-tag{color:var(--nk-accent-2);background:color-mix(in srgb,var(--nk-accent-2) 14%,transparent);padding:0 3px;cursor:pointer}
.nk-cm-source .nk-cm-tag{cursor:text}
.nk-cm-task{margin:0 6px 0 0;vertical-align:middle;accent-color:var(--nk-accent);cursor:pointer}
.nk-cm-done{color:var(--nk-fg3);text-decoration:line-through}
.nk-cm-embed-img{display:block;max-width:100%;max-height:320px;margin:6px 0;border:1px solid var(--nk-line);cursor:pointer}
.nk-cm-embed-chip{font-size:.92em}
.nk-cm .cm-tooltip-autocomplete{background:var(--nk-bg2);border:1px solid var(--nk-line);box-shadow:var(--nk-shadow);font-family:var(--nk-text)}
.nk-cm .cm-tooltip-autocomplete ul li[aria-selected]{background:color-mix(in srgb,var(--nk-accent) 22%,transparent);color:var(--nk-fg)}
.nk-toolbar-hint{margin-left:auto;font-size:11px;color:var(--nk-fg3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.nk-textarea{width:100%;height:100%;resize:none;border:none;outline:none;background:var(--nk-bg);color:var(--nk-fg);font-family:var(--nk-mono);font-size:13.5px;line-height:1.65;padding:18px 22px;tab-size:2}
.nk-split .nk-textarea{border-right:1px solid var(--nk-line)}
.nk-root .nk-textarea:focus,.nk-root .nk-textarea:focus-visible{outline:none !important;box-shadow:none !important}
.nk-preview{overflow:auto;padding:18px 26px 60px;min-height:0}
.nk-status{display:flex;gap:14px;padding:4px 14px;border-top:1px solid var(--nk-line);font-size:11px;color:var(--nk-fg3);font-family:var(--nk-mono);flex:none;flex-wrap:wrap}
.nk-status .nk-dirty{color:var(--nk-warn)} .nk-status .nk-saved{color:var(--nk-ok)} .nk-status .nk-errtxt{color:var(--nk-err)}
.nk-md{max-width:820px;overflow-wrap:anywhere}
.nk-md h1,.nk-md h2,.nk-md h3{line-height:1.25;margin:1.2em 0 .5em}
.nk-md h1{font-size:1.7em;border-bottom:1px solid var(--nk-line);padding-bottom:.25em}
.nk-md h2{font-size:1.35em} .nk-md h3{font-size:1.12em}
.nk-md a{color:var(--dsw-alias-link,var(--nk-accent2));text-decoration:none;border-bottom:1px solid color-mix(in srgb,currentColor 35%,transparent)}
.nk-md a.nk-unresolved{opacity:.6;border-bottom-style:dashed}
.nk-md a.nk-tag{border:1px solid var(--nk-line);padding:0 5px;font-size:.88em;color:var(--nk-accent2)}
.nk-md code{font-family:var(--nk-mono);font-size:.9em;background:var(--nk-bg3);padding:1px 4px}
.nk-md pre{background:var(--nk-bg3);padding:12px 14px;overflow:auto;border:1px solid var(--nk-line)}
.nk-md pre code{background:none;padding:0}
.nk-md blockquote{margin:1em 0;padding:.2em 1em;border-left:3px solid var(--nk-accent2);color:var(--nk-fg2)}
.nk-md table{border-collapse:collapse;margin:1em 0} .nk-md th,.nk-md td{border:1px solid var(--nk-line);padding:5px 9px}
.nk-md img.nk-embed-img{max-width:100%;border:1px solid var(--nk-line);display:block;margin:.6em 0}
.nk-md audio,.nk-md video{width:100%;max-width:560px;display:block;margin:.6em 0}
.nk-md li:has(> input.nk-task){list-style:none;margin-left:-1.2em}
.nk-md input.nk-task{accent-color:var(--nk-accent);margin-right:6px;cursor:pointer}
.nk-md hr{border:none;border-top:1px solid var(--nk-line)}
.nk-callout{border:1px solid var(--nk-line);border-left:3px solid var(--nk-accent2);background:color-mix(in srgb,var(--nk-accent2) 8%,transparent);padding:8px 12px;margin:1em 0}
.nk-callout-warning,.nk-callout-danger,.nk-callout-caution{border-left-color:var(--nk-err);background:color-mix(in srgb,var(--nk-err) 8%,transparent)}
.nk-callout-tip,.nk-callout-success{border-left-color:var(--nk-ok)}
.nk-callout-title{font-family:var(--nk-display);font-size:11px;letter-spacing:.06em;text-transform:uppercase;margin-bottom:4px}
.nk-props{border:1px solid var(--nk-line);margin:0 0 14px;font-size:12px;font-family:var(--nk-mono)}
.nk-props div{display:flex;gap:10px;padding:3px 8px;border-bottom:1px solid var(--nk-line)} .nk-props div:last-child{border-bottom:none}
.nk-props b{color:var(--nk-fg3);font-weight:400;min-width:90px}
.nk-h{font-family:var(--nk-display);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--nk-fg3);margin:14px 0 6px}
.nk-h:first-child{margin-top:0}
.nk-link{display:block;padding:2px 0;cursor:pointer;color:var(--nk-fg2);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.nk-link:hover{color:var(--nk-accent)}
.nk-chip{display:inline-block;border:1px solid var(--nk-line);padding:0 6px;margin:0 4px 4px 0;font-size:12px;cursor:pointer;color:var(--nk-accent2)}
.nk-chip:hover{border-color:var(--nk-accent2)}
.nk-chip.nk-on{background:var(--nk-accent2);color:var(--nk-on-accent)}
.nk-hits{overflow:auto;padding:10px 16px;min-height:0;flex:1}
.nk-hit{border:1px solid var(--nk-line);padding:9px 12px;margin-bottom:8px;cursor:pointer;background:var(--nk-bg2)}
.nk-hit:hover{border-color:var(--nk-accent)}
.nk-hit b{display:block;margin-bottom:2px} .nk-hit small{color:var(--nk-fg3);font-family:var(--nk-mono);font-size:11px}
.nk-hit p{margin:4px 0 0;color:var(--nk-fg2);font-size:12.5px}
.nk-mark{background:color-mix(in srgb,var(--nk-accent) 35%,transparent);color:inherit}
.nk-banner{padding:8px 14px;border-bottom:1px solid var(--nk-line);display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:13px}
.nk-banner.nk-warnb{background:color-mix(in srgb,var(--nk-warn) 14%,transparent)}
.nk-banner.nk-errb{background:color-mix(in srgb,var(--nk-err) 14%,transparent)}
.nk-overlay{position:absolute;inset:0;background:var(--dsw-alias-bg-mask-drop,rgba(19,17,16,.7));display:flex;align-items:center;justify-content:center;z-index:50;padding:16px}
.nk-modal{background:var(--nk-bg2);border:1px solid var(--nk-line);box-shadow:var(--nk-shadow);width:min(520px,100%);max-height:100%;overflow:auto}
.nk-modal-h{font-family:var(--nk-display);font-size:12px;letter-spacing:.08em;text-transform:uppercase;padding:10px 14px;border-bottom:1px solid var(--nk-line);display:flex;align-items:center}
.nk-modal-b{padding:14px;display:flex;flex-direction:column;gap:10px}
.nk-modal-f{padding:10px 14px;border-top:1px solid var(--nk-line);display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
.nk-danger-box{border:2px solid var(--nk-err);background:color-mix(in srgb,var(--nk-err) 12%,transparent);padding:12px;font-weight:700;color:var(--nk-fg);display:flex;gap:10px;align-items:flex-start}
.nk-danger-box .nk-bang{font-family:var(--nk-display);color:var(--nk-err);font-size:22px;line-height:1}
.nk-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--nk-fg2)}
.nk-ai{position:relative;display:inline-flex;align-items:stretch;margin:0 4px 0 2px}
.nk-ai-main{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;border:1px solid var(--nk-accent);background:color-mix(in srgb,var(--nk-accent) 14%,transparent);color:var(--nk-fg);font-family:var(--nk-display);font-size:10px;letter-spacing:.06em;text-transform:uppercase;cursor:pointer}
.nk-ai-main:hover:not(:disabled){background:var(--nk-accent);color:var(--nk-on-accent);box-shadow:3px 3px 0 rgba(0,0,0,.4)}
.nk-ai-main:disabled{opacity:.5;cursor:default}
.nk-ai.nk-busy .nk-ai-main svg{animation:nk-spin 1.2s steps(8) infinite}
.nk-ai-gear{position:absolute;right:-6px;bottom:-6px;width:16px;height:16px;padding:0;display:grid;place-items:center;border:1px solid var(--nk-line);background:var(--nk-bg2);color:var(--nk-fg2);cursor:pointer}
.nk-ai-gear:hover{border-color:var(--nk-accent);color:var(--nk-accent)}
@keyframes nk-spin{to{transform:rotate(360deg)}}
.nk-seg{display:flex;gap:0;margin-bottom:12px;border:1px solid var(--nk-line);width:max-content;max-width:100%;overflow-x:auto}
.nk-seg button{border:none;border-right:1px solid var(--nk-line);background:none;color:var(--nk-fg2);padding:6px 12px;cursor:pointer;font-family:var(--nk-display);font-size:10px;letter-spacing:.06em;text-transform:uppercase;white-space:nowrap}
.nk-seg button:last-child{border-right:none}
.nk-seg button.nk-on{background:var(--nk-accent);color:var(--nk-on-accent)}
.nk-diff{max-height:52vh;overflow:auto;margin:0;padding:10px;background:var(--nk-bg);border:1px solid var(--nk-line);font-family:var(--nk-mono);font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-word}
.nk-diff-add{background:color-mix(in srgb,var(--nk-ok) 18%,transparent)}
.nk-diff-del{background:color-mix(in srgb,var(--nk-err) 16%,transparent);text-decoration:line-through;text-decoration-color:color-mix(in srgb,var(--nk-err) 60%,transparent)}
.nk-connect{display:flex;flex-direction:column;gap:10px;font-size:13px;line-height:1.55}
.nk-connect p{margin:0}
.nk-connect code,.nk-creds code{font-family:var(--nk-mono);font-size:12px;background:var(--nk-bg3);padding:1px 5px;word-break:break-all}
.nk-steps{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:8px}
.nk-code{display:flex;align-items:center;gap:10px;margin-top:6px}
.nk-code span{font-family:var(--nk-mono);font-size:22px;letter-spacing:.12em;padding:6px 12px;border:1px solid var(--nk-accent);background:var(--nk-bg);box-shadow:var(--nk-shadow)}
.nk-code small{color:var(--nk-fg3)}
.nk-row2{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.nk-creds{border:1px solid var(--nk-accent);padding:10px;display:flex;flex-direction:column;gap:6px;background:var(--nk-bg)}
.nk-creds div{display:flex;gap:8px;align-items:center}
.nk-creds div span{width:90px;color:var(--nk-fg3);font-size:12px;flex:none}
.nk-devices{width:100%;border-collapse:collapse;font-size:12.5px}
.nk-devices th,.nk-devices td{border-bottom:1px solid var(--nk-line);padding:6px 8px;text-align:left;vertical-align:top}
.nk-devices th{font-family:var(--nk-display);font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:var(--nk-fg3);font-weight:400}
.nk-btn.nk-sm{padding:2px 8px;font-size:11px;height:auto}
.nk-cloudstate{display:flex;gap:16px;flex-wrap:wrap;font-size:12px;color:var(--nk-fg2)}
.nk-importprog{display:flex;flex-direction:column;gap:6px}
.nk-importprog progress{width:100%;accent-color:var(--nk-accent)}
.nk-check{display:flex;gap:8px;align-items:flex-start;font-size:13px;cursor:pointer}
.nk-meter{height:6px;background:var(--nk-bg3);border:1px solid var(--nk-line)} .nk-meter i{display:block;height:100%;background:var(--nk-accent);transition:width .08s}
.nk-strength{height:4px;margin-top:2px;background:var(--nk-bg3)} .nk-strength i{display:block;height:100%}
.nk-menu{position:fixed;z-index:1000;background:var(--nk-bg2);border:1px solid var(--nk-line);box-shadow:var(--nk-shadow);min-width:190px;padding:4px 0}
.nk-menu button{display:block;width:100%;text-align:left;padding:6px 12px;border:none;background:none;cursor:pointer;font-size:13px;color:var(--nk-fg2)}
.nk-menu button:hover{background:color-mix(in srgb,var(--nk-accent) 16%,transparent);color:var(--nk-fg)}
.nk-menu hr{border:none;border-top:1px solid var(--nk-line);margin:4px 0}
.nk-rec{padding:22px;display:flex;flex-direction:column;gap:14px;max-width:720px;overflow:auto}
.nk-rec-time{font-family:var(--nk-display);font-size:34px;letter-spacing:.04em}
.nk-rec-dot{width:12px;height:12px;background:var(--nk-err);display:inline-block;animation:nk-blink 1s steps(2) infinite}
@keyframes nk-blink{50%{opacity:0}}
.nk-attach{padding:18px;overflow:auto;display:flex;flex-direction:column;gap:12px;align-items:flex-start}
.nk-attach img{max-width:100%;border:1px solid var(--nk-line)}
.nk-attach object{width:100%;height:75vh;border:1px solid var(--nk-line)}
.nk-toast{position:absolute;bottom:18px;left:50%;transform:translateX(-50%);background:var(--nk-bg3);border:1px solid var(--nk-line);box-shadow:var(--nk-shadow);padding:8px 14px;z-index:60;font-size:13px;max-width:90%}
.nk-toast.nk-errt{border-color:var(--nk-err)}
.nk-dropzone{outline:2px dashed var(--nk-accent);outline-offset:-6px}
.nk-panel-icon{display:inline-flex;align-items:center;justify-content:center}
@container nk (max-width:1100px){.nk-body{grid-template-columns:230px minmax(0,1fr)}.nk-info{display:none}}
@container nk (max-width:760px){.nk-head{padding-right:14px}.nk-body,.nk-body.nk-no-info{grid-template-columns:1fr}.nk-side{display:none}.nk-root.nk-show-side .nk-side{display:flex;position:absolute;z-index:40;top:0;bottom:0;left:0;width:82%;box-shadow:var(--nk-shadow)}.nk-editwrap.nk-split{grid-template-columns:1fr}.nk-split .nk-preview{display:none}.nk-search{width:140px}}
@container nk (min-width:761px){.nk-only-narrow{display:none}}
`
