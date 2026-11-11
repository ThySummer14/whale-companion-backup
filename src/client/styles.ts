export const STYLES = String.raw`
.companion-panel{--cp-blue:#2878c8;--cp-ink:var(--dsw-alias-text-primary,#17202a);--cp-muted:var(--dsw-alias-text-secondary,#687484);--cp-line:var(--dsw-alias-border-l2,rgba(120,140,160,.22));height:100%;overflow:auto;color:var(--cp-ink);background:var(--dsw-alias-bg-layer-0,#f5f7fa);font-size:13px;line-height:1.55}
.companion-panel *{box-sizing:border-box}.cp-wrap{max-width:1180px;margin:0 auto;padding:28px 30px 48px}.cp-header{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;margin-bottom:22px}.cp-title{margin:0;font-size:25px;font-weight:700;letter-spacing:-.4px}.cp-subtitle{margin:5px 0 0;color:var(--cp-muted)}.cp-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:20px;padding:5px;border:1px solid var(--cp-line);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff)}.cp-tab{border:0;border-radius:8px;background:transparent;color:var(--cp-muted);padding:7px 15px;cursor:pointer;font:inherit}.cp-tab[data-active=true]{background:var(--cp-blue);color:white}.cp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px;margin-bottom:16px}.cp-card{border:1px solid var(--cp-line);border-radius:14px;background:var(--dsw-alias-bg-layer-1,#fff);padding:16px;margin-bottom:16px}.cp-grid .cp-card{margin:0}.cp-card h2{font-size:15px;margin:0 0 12px}.cp-card h3{font-size:13px;margin:0}.cp-metric{font-size:25px;font-weight:700;margin-top:4px}.cp-label{font-size:12px;color:var(--cp-muted)}.cp-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.cp-between{justify-content:space-between}.cp-stack{display:flex;flex-direction:column;gap:12px}.cp-presence{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--cp-line);border-radius:999px;padding:5px 11px;background:var(--dsw-alias-bg-layer-1,#fff)}.cp-dot{width:8px;height:8px;border-radius:50%;background:#98a2af}.cp-dot[data-state=running],.cp-dot[data-state=ready],.cp-dot[data-state=success]{background:#22a06b}.cp-dot[data-state=idle]{background:#4b8dcc}.cp-dot[data-state=warning],.cp-dot[data-state=planned],.cp-dot[data-state=unconfigured]{background:#d59420}.cp-dot[data-state=error],.cp-dot[data-state=offline]{background:#d74c4c}.cp-button{border:1px solid var(--cp-line);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;padding:7px 13px;cursor:pointer;font:inherit}.cp-button:hover{border-color:var(--cp-blue)}.cp-button[data-primary=true]{background:var(--cp-blue);border-color:var(--cp-blue);color:#fff}.cp-button:disabled{opacity:.5;cursor:not-allowed}.cp-input,.cp-select,.cp-textarea{width:100%;border:1px solid var(--cp-line);border-radius:8px;background:var(--dsw-alias-bg-layer-2,#fff);color:inherit;padding:8px 10px;font:inherit}.cp-textarea{min-height:150px;resize:vertical}.cp-field{display:flex;flex-direction:column;gap:5px}.cp-hint,.cp-empty{color:var(--cp-muted)}.cp-empty{text-align:center;padding:30px 12px}.cp-error{color:#c43f3f;padding:10px 12px;border:1px solid rgba(196,63,63,.3);border-radius:9px;background:rgba(196,63,63,.06);margin-bottom:14px}.cp-table{width:100%;border-collapse:collapse}.cp-table th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--cp-muted);font-weight:600}.cp-table th,.cp-table td{padding:10px 8px;border-bottom:1px solid var(--cp-line);vertical-align:top}.cp-table tr:last-child td{border-bottom:0}.cp-kind{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;white-space:nowrap}.cp-meta{color:var(--cp-muted);font-size:11px;white-space:nowrap}.cp-status{display:inline-block;border-radius:999px;padding:2px 8px;background:rgba(120,140,160,.12);font-size:11px}.cp-status[data-state=error],.cp-status[data-state=failed]{color:#c43f3f;background:rgba(196,63,63,.09)}.cp-status[data-state=success],.cp-status[data-state=ready],.cp-status[data-state=succeeded]{color:#158055;background:rgba(21,128,85,.09)}.cp-capabilities{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.cp-capabilities .cp-card{margin:0}.cp-capability-top{display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:9px}.cp-code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--cp-muted);word-break:break-all}.cp-session{padding:14px;border:1px solid var(--cp-line);border-radius:10px;margin-bottom:12px}.cp-session .cp-select{max-width:520px}.cp-small{font-size:12px}.cp-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}@media(max-width:700px){.cp-wrap{padding:20px 15px 36px}.cp-header{flex-direction:column}.cp-table{min-width:650px}.cp-table-wrap{overflow-x:auto}.cp-tab{padding:7px 10px}}
.cp-home-layout{display:flex;align-items:flex-start;flex-wrap:wrap;gap:16px}
.cp-home-room{flex:3 1 460px;min-width:0}.cp-home-history{flex:1 1 230px;min-width:0}
.cp-home-room h2,.cp-home-history h2{margin:0}.cp-home-subtitle{margin:3px 0 0}
.cp-home-map{position:relative;margin:14px 0 10px}
.cp-home-scene{display:block;width:100%;border:1px solid var(--cp-line);border-radius:11px}
.cp-home-scene[data-tone=night]{filter:saturate(.75) brightness(.87)}
.cp-home-scene[data-tone=night] .cp-home-sky{fill:#737e9b}.cp-home-scene[data-tone=night] .cp-home-lamp{fill:#ffdb86}
.cp-home-scene[data-tone=quiet]{filter:saturate(.58)}
.cp-home-monitor[data-active=true]{fill:#a4e7ce}
.cp-home-spot{position:absolute;transform:translate(-50%,-50%);border:1px solid #d6b99e;border-radius:999px;padding:3px 8px;min-height:24px;cursor:pointer;background:#fff5e4;color:#49394a;font:600 clamp(10px,2vw,13px)/1.2 system-ui,sans-serif;white-space:nowrap}
.cp-home-spot[data-current=true]{box-shadow:0 0 0 2px #a95d47;color:#753828}.cp-home-spot[aria-pressed=true]{background:#49394a;border-color:#49394a;color:#fff7ee}
.cp-home-spot:focus-visible,.cp-home-room:focus-visible{outline:2px solid #365a76;outline-offset:3px}
.cp-home-inspection{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:13px;padding:11px 12px;background:var(--cp-bg,#f8f6f3);border:1px solid var(--cp-line);border-radius:9px}
.cp-home-inspection p{margin:3px 0;color:var(--cp-muted);font-size:12px}
.cp-visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.cp-home-state{display:inline-flex;align-items:center;gap:7px;border-radius:999px;padding:5px 11px;background:#f2ebe0;color:#65594f;font-size:12px;font-weight:650}
.cp-home-state::before{content:'';width:7px;height:7px;border-radius:50%;background:currentColor}
.cp-home-state[data-activity=minecraft]{background:#dceadd;color:#315d45}
.cp-home-state[data-activity=chatting]{background:#f6e3da;color:#804a40}
.cp-home-state[data-activity=reflecting]{background:#eee6d5;color:#684b33}
.cp-home-state[data-activity=speaking],.cp-home-state[data-activity=resting]{background:#e9e1f0;color:#5e4c72}
.cp-home-caption{color:var(--cp-muted);font-size:12px}.cp-home-caption time,.cp-home-events time{white-space:nowrap}
.cp-home-journal{margin:10px 0 0;padding:6px 0 0;border-top:1px solid var(--cp-line);color:var(--cp-muted);font-size:12px}.cp-home-journal time{white-space:nowrap}
.cp-home-events{margin:10px 0 0;padding:0;list-style:none}
.cp-home-events li{display:flex;align-items:baseline;justify-content:space-between;gap:8px;flex-wrap:wrap;padding:10px 0;border-top:1px solid var(--cp-line)}
.cp-home-events time,.cp-home-empty{color:var(--cp-muted);font-size:12px}.cp-home-empty{margin:15px 0 1px}
.cp-bili-candidates{margin:12px 0 0;padding:0;list-style:none}.cp-bili-history summary{cursor:pointer;color:var(--cp-muted)}
.cp-feed-song{gap:8px;margin:10px 0;padding:10px 12px;border:1px solid var(--cp-line);border-radius:10px;background:var(--dsw-alias-bg-layer-2,#fff)}
.cp-feed-song strong{min-width:0;overflow-wrap:anywhere}
.cp-house-comparison{display:flex;flex-wrap:wrap;align-items:flex-start;gap:12px 20px}
.cp-house-layer{flex:0 1 220px;min-width:0}
.cp-house-reference{margin:0;flex:1 1 280px;min-width:0;max-width:440px}
.cp-house-reference figcaption{margin:12px 0 8px}
.cp-house-reference img{display:block;max-width:100%;max-height:300px;object-fit:contain;border:1px solid var(--cp-line);border-radius:8px}
.cp-house-grid{display:grid;gap:4px;width:min(100%,220px);margin:8px 0}
.cp-house-cell{display:grid;place-items:center;aspect-ratio:1;min-width:0;border:1px solid var(--cp-line);border-radius:4px;font-size:12px;font-weight:600;background:var(--dsw-alias-bg-layer-2,#fff)}
.cp-house-cell[data-block=oak_planks]{background:#efdfbe;color:#654826}
.cp-house-cell[data-block=spruce_planks]{background:#c9b293;color:#4a3421}
.cp-house-cell[data-block=cobblestone]{background:#d5d8db;color:#333c46}
.cp-house-cell[data-block=glass]{background:#d8edf2;color:#295464}
.cp-house-cell[data-block=air]{border-style:dashed;color:var(--cp-muted)}
button.cp-house-cell{cursor:pointer;padding:0;min-height:36px;font-family:inherit}
button.cp-house-cell:hover,button.cp-house-cell[data-changed=true]{border-color:var(--cp-blue);border-style:solid}
button.cp-house-cell:focus-visible{outline:2px solid var(--cp-blue);outline-offset:1px}
button.cp-house-cell:disabled{cursor:wait}
.cp-house-edit{margin-top:12px;border-top:1px solid var(--cp-line)}
.cp-house-history{margin-top:12px;max-width:350px}
.cp-house-materials span{white-space:nowrap}
.cp-house-shortage{margin-top:12px;padding:10px 12px;border:1px solid var(--cp-line);border-radius:9px;max-width:440px}
.cp-house-shortage table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}
.cp-house-shortage caption{text-align:left;font-weight:600;margin-bottom:4px}
.cp-house-shortage th,.cp-house-shortage td{padding:4px;text-align:right}
.cp-house-shortage th:first-child{text-align:left}
.cp-house-shortage thead th{color:var(--cp-muted);font-weight:500}
.cp-house-shortage tbody tr{border-top:1px solid var(--cp-line)}
.cp-house-shortage td[data-short=true]{font-weight:700}
.cp-house-shortage p{margin:8px 0}
.cp-house-recovery{margin:12px 0;padding:10px 12px;border:1px solid var(--cp-line);border-radius:9px;max-width:440px}
.cp-house-recovery p{margin:6px 0 0}
.cp-house-notes{white-space:pre-wrap;overflow-wrap:anywhere}
.cp-house-project-section{max-width:100%;overflow-wrap:anywhere}
.cp-house-project-import{margin-top:16px;border-top:1px solid var(--cp-line);padding-top:10px}
.cp-house-project-import summary{cursor:pointer;color:var(--cp-muted)}
.cp-house-project-import form{margin-top:12px;max-width:560px}
.cp-house-project-import textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.cp-house-import-plan{margin:0;overflow-wrap:anywhere}
.cp-house-import-plan ol{margin:9px 0;padding-inline-start:24px}
.cp-house-import-plan li{padding:6px 0;border-top:1px solid var(--cp-line)}
.cp-house-import-plan li p{margin:2px 0}
`
