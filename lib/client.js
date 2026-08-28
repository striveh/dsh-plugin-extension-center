window.__ModuleLoader__.load({
	id: "dsh-plugin-extension-center",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region \0dsh-extension-center-css:src/client/ExtensionCenter.module.css.mjs
		const cssText = "._6YbJdq_trigger{box-sizing:border-box;width:100%;height:36px;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:10px;align-items:center;gap:10px;margin:0;padding:0 12px;font-size:14px;line-height:20px;display:flex;overflow:hidden}._6YbJdq_trigger:hover,._6YbJdq_trigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}._6YbJdq_trigger:focus-visible,._6YbJdq_close:focus-visible,._6YbJdq_tabs button:focus-visible,._6YbJdq_actions button:focus-visible,._6YbJdq_store button:focus-visible,._6YbJdq_store input:focus-visible,._6YbJdq_store select:focus-visible,._6YbJdq_managementPanel button:focus-visible,._6YbJdq_managementPanel input:focus-visible,._6YbJdq_managementPanel textarea:focus-visible,._6YbJdq_planReview button:focus-visible,._6YbJdq_planReview:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}._6YbJdq_candidateScope{color:var(--dsw-alias-label-secondary);gap:5px;margin-top:12px;font-size:11px;font-weight:600;display:grid}._6YbJdq_candidateScope select{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-height:32px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;padding:5px 8px}._6YbJdq_managementPanel{flex-direction:column;gap:16px;display:flex}._6YbJdq_panelHeading,._6YbJdq_inventoryCard>header,._6YbJdq_updateCard>header,._6YbJdq_activityCard>header,._6YbJdq_planReview>header{justify-content:space-between;align-items:flex-start;gap:16px;display:flex}._6YbJdq_panelHeading h3,._6YbJdq_panelHeading p,._6YbJdq_inventoryCard h4,._6YbJdq_updateCard h4,._6YbJdq_activityCard h4,._6YbJdq_planReview h3,._6YbJdq_planReview p{margin:0}._6YbJdq_panelHeading h3,._6YbJdq_planReview h3{font-size:16px;line-height:24px}._6YbJdq_panelHeading p,._6YbJdq_planReview header p{color:var(--dsw-alias-label-tertiary);margin-top:4px;font-size:12px;line-height:19px}._6YbJdq_panelHeading>code{overflow-wrap:anywhere;max-width:42%;color:var(--dsw-alias-label-tertiary);font-size:10px}._6YbJdq_managementLoading,._6YbJdq_managementError,._6YbJdq_inventoryWarning,._6YbJdq_mutationError{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:12px;padding:16px;font-size:12px;line-height:19px}._6YbJdq_managementError p,._6YbJdq_mutationError p{margin:5px 0 10px}._6YbJdq_managementError code,._6YbJdq_mutationError code{overflow-wrap:anywhere;margin-bottom:10px;display:block}._6YbJdq_managementError button,._6YbJdq_inlineActions button,._6YbJdq_lifecycleActions button,._6YbJdq_updateCard button,._6YbJdq_activityCard button,._6YbJdq_planReview button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-height:32px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:8px;padding:5px 11px;font-size:12px;line-height:18px}._6YbJdq_managementError button:disabled,._6YbJdq_inlineActions button:disabled,._6YbJdq_lifecycleActions button:disabled,._6YbJdq_updateCard button:disabled,._6YbJdq_activityCard button:disabled,._6YbJdq_planReview button:disabled{cursor:not-allowed;opacity:.6}._6YbJdq_inventoryList,._6YbJdq_updateList{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;display:grid}._6YbJdq_inventoryCard,._6YbJdq_updateCard,._6YbJdq_activityCard,._6YbJdq_planReview{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:14px;min-width:0;padding:16px}._6YbJdq_inventoryCard>header>div,._6YbJdq_updateCard>header>div,._6YbJdq_activityCard>header>div{min-width:0}._6YbJdq_inventoryCard header span,._6YbJdq_updateCard header span,._6YbJdq_activityCard header span,._6YbJdq_planReview header span{color:var(--dsw-alias-state-business-primary);text-transform:uppercase;font-size:10px;font-weight:600}._6YbJdq_inventoryCard h4,._6YbJdq_updateCard h4,._6YbJdq_activityCard h4{overflow-wrap:anywhere;margin-top:3px;font-size:14px;line-height:21px}._6YbJdq_inventoryCard header code,._6YbJdq_updateCard header code,._6YbJdq_activityCard header code{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-size:10px}._6YbJdq_stateGrid,._6YbJdq_planFacts{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:14px 0;display:grid}._6YbJdq_stateGrid div,._6YbJdq_planFacts div,._6YbJdq_updateCard dl div,._6YbJdq_activityCard dl div{background:var(--dsw-alias-bg-layer-2);border-radius:8px;min-width:0;padding:8px}._6YbJdq_stateGrid dt,._6YbJdq_planFacts dt,._6YbJdq_updateCard dt,._6YbJdq_activityCard dt{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:16px}._6YbJdq_stateGrid dd,._6YbJdq_planFacts dd,._6YbJdq_updateCard dd,._6YbJdq_activityCard dd{overflow-wrap:anywhere;margin:2px 0 0;font-size:11px;line-height:17px}._6YbJdq_targetLine,._6YbJdq_updateTarget,._6YbJdq_activityCard>p{color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;margin:8px 0;font-size:11px;line-height:18px}._6YbJdq_lifecycleActions,._6YbJdq_inlineActions,._6YbJdq_decisionActions{flex-wrap:wrap;gap:7px;margin-top:12px;display:flex}._6YbJdq_configurationDraft{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;margin-top:14px;padding:12px}._6YbJdq_configurationDraft h5,._6YbJdq_configurationDraft p{margin:0}._6YbJdq_configurationDraft p{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11px}._6YbJdq_configurationDraft label{gap:5px;margin-top:10px;font-size:11px;display:grid}._6YbJdq_configurationDraft textarea{box-sizing:border-box;resize:vertical;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;min-height:92px;color:var(--dsw-alias-label-primary);font-family:var(--ds-font-family-code);border-radius:8px;padding:8px}._6YbJdq_typedConfigGrid{grid-template-columns:repeat(2,minmax(0,1fr));gap:9px;margin-top:12px;display:grid}._6YbJdq_typedConfigGrid label{margin:0}._6YbJdq_typedConfigGrid input{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);width:100%;min-height:32px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;padding:5px 8px}._6YbJdq_typedConfigGrid small{color:var(--dsw-alias-label-tertiary);font-size:9px}._6YbJdq_updateCard dl,._6YbJdq_activityCard dl{gap:7px;margin:14px 0;display:grid}._6YbJdq_activityList{gap:12px;margin:0;padding:0;list-style:none;display:grid}._6YbJdq_recoveryCallout,._6YbJdq_planDenied,._6YbJdq_decisionResult{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:10px;margin-top:12px;padding:11px;font-size:11px;line-height:18px}._6YbJdq_recoveryCallout p,._6YbJdq_planDenied p,._6YbJdq_decisionResult p{margin:4px 0 0}._6YbJdq_planReview{border-color:var(--dsw-alias-state-business-primary);margin-top:4px}._6YbJdq_planReview>header>div{max-width:700px}._6YbJdq_planPermissions{margin-top:14px}._6YbJdq_planPermissions h4,._6YbJdq_planPermissions p,._6YbJdq_planPermissions ul{margin:0}._6YbJdq_planPermissions ul{gap:7px;padding:0;list-style:none;display:grid}._6YbJdq_planPermissions li{background:var(--dsw-alias-bg-layer-2);border-radius:8px;gap:2px;padding:8px;font-size:11px;display:grid}._6YbJdq_configurationDiff{background:var(--dsw-alias-bg-module-platform);border-radius:10px;margin-top:14px;padding:11px}._6YbJdq_configurationDiff h4,._6YbJdq_configurationDiff p,._6YbJdq_configurationDiff pre{margin:0}._6YbJdq_configurationDiff pre{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);border-radius:8px;margin-top:8px;padding:9px;font-size:10px;line-height:17px;overflow-x:auto}._6YbJdq_configurationDiff p{overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary);margin-top:7px;font-size:10px}._6YbJdq_primaryAction{border-color:var(--dsw-alias-state-business-primary)!important;background:var(--dsw-alias-state-business-primary)!important;color:#fff!important}._6YbJdq_trigger[data-wide=false]{justify-content:center;width:36px;padding:0}._6YbJdq_dialog{border-radius:24px;gap:0;width:min(980px,100%);height:min(720px,100vh - 48px);padding:0}._6YbJdq_surface{background:var(--dsw-alias-bg-layer-2);min-width:0;min-height:0;color:var(--dsw-alias-label-primary);flex-direction:column;flex:1;display:flex}._6YbJdq_header{border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;justify-content:space-between;align-items:flex-start;gap:24px;padding:28px 28px 18px;display:flex}._6YbJdq_titleBlock{min-width:0}._6YbJdq_eyebrow{color:var(--dsw-alias-state-business-primary);flex-wrap:wrap;align-items:center;gap:8px;margin-bottom:8px;font-size:12px;font-weight:600;line-height:18px;display:flex}._6YbJdq_host{background:var(--dsw-alias-bg-layer-1);min-height:20px;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);border-radius:6px;align-items:center;padding:1px 7px;font-size:11px;font-weight:500;line-height:16px;display:inline-flex}._6YbJdq_titleBlock h2,._6YbJdq_titleBlock p,._6YbJdq_empty h3,._6YbJdq_empty p,._6YbJdq_kindCard h3,._6YbJdq_kindCard p,._6YbJdq_lifecycle h3,._6YbJdq_lifecycle p{margin:0}._6YbJdq_titleBlock h2{font-size:24px;font-weight:600;line-height:32px}._6YbJdq_titleBlock p{max-width:680px;color:var(--dsw-alias-label-tertiary);margin-top:5px;font-size:14px;line-height:22px}._6YbJdq_close{width:32px;height:32px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:0;border-radius:9px;flex:none;place-items:center;padding:0;display:inline-grid}._6YbJdq_close:hover{background:var(--dsw-alias-interactive-bg-hover)}._6YbJdq_tabs{border-bottom:1px solid var(--dsw-alias-border-l2);flex:none;gap:28px;padding:0 28px;display:flex}._6YbJdq_tabs button{min-height:46px;color:var(--dsw-alias-label-tertiary);font:inherit;cursor:pointer;background:0 0;border:0;padding:0;font-size:13px;font-weight:600;line-height:20px;position:relative}._6YbJdq_tabs button:after{content:\"\";background:0 0;border-radius:2px;height:2px;position:absolute;bottom:-1px;left:0;right:0}._6YbJdq_tabs button[aria-selected=true]{color:var(--dsw-alias-state-business-primary)}._6YbJdq_tabs button[aria-selected=true]:after{background:var(--dsw-alias-state-business-primary)}._6YbJdq_panels{flex:1;min-height:0;display:flex}._6YbJdq_panel{box-sizing:border-box;width:100%;padding:24px 28px 30px;overflow-y:auto}._6YbJdq_panel[hidden]{display:none}._6YbJdq_store{flex-direction:column;gap:18px;display:flex}._6YbJdq_empty{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:14px;padding:18px 20px}._6YbJdq_empty h3,._6YbJdq_lifecycle h3{font-size:14px;font-weight:600;line-height:22px}._6YbJdq_empty p,._6YbJdq_lifecycle p{color:var(--dsw-alias-label-tertiary);margin-top:4px;font-size:13px;line-height:20px}._6YbJdq_empty code,._6YbJdq_lifecycle code{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code);border-radius:6px;margin-top:10px;padding:3px 7px;font-size:11px;line-height:17px;display:inline-flex}._6YbJdq_kindGrid{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;display:grid}._6YbJdq_kindCard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:14px;min-width:0;padding:16px}._6YbJdq_kindStatus{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);border-radius:6px;margin-bottom:14px;padding:2px 7px;font-size:11px;font-weight:500;line-height:17px;display:inline-flex}._6YbJdq_kindCard h3{font-size:14px;font-weight:600;line-height:22px}._6YbJdq_kindCard p{color:var(--dsw-alias-label-tertiary);margin-top:5px;font-size:12px;line-height:19px}._6YbJdq_lifecycle{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-module-platform);border-radius:14px;justify-content:space-between;align-items:flex-end;gap:24px;padding:18px 20px;display:flex}._6YbJdq_lifecycle>div:first-child{max-width:520px}._6YbJdq_capabilityGrid{grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 14px;min-width:280px;margin:0;display:grid}._6YbJdq_capabilityGrid div{color:var(--dsw-alias-label-secondary);justify-content:space-between;gap:10px;font-size:11px;line-height:17px;display:flex}._6YbJdq_capabilityGrid dd{margin:0;font-weight:600}._6YbJdq_capabilityGrid dd[data-capability-status=missing]{color:var(--dsw-alias-state-error-primary)}._6YbJdq_empty ._6YbJdq_capabilityGrid{margin-top:12px}._6YbJdq_actions{flex-wrap:wrap;justify-content:flex-end;gap:7px;display:flex}._6YbJdq_actions button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-height:30px;color:var(--dsw-alias-label-tertiary);font:inherit;border-radius:8px;padding:4px 10px;font-size:12px;line-height:18px}._6YbJdq_actions button:disabled{cursor:not-allowed;opacity:.66}._6YbJdq_catalogLoading,._6YbJdq_discoveryError{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:14px;padding:26px;font-size:13px;line-height:20px}._6YbJdq_discoveryError p{margin:6px 0 12px}._6YbJdq_discoveryError code{overflow-wrap:anywhere;color:var(--dsw-alias-label-tertiary);margin-bottom:14px;font-size:11px;display:block}._6YbJdq_discoveryError button,._6YbJdq_discoveryHeading button,._6YbJdq_cardActions button,._6YbJdq_detail button,._6YbJdq_comparison button{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);min-height:32px;color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;border-radius:8px;padding:5px 11px;font-size:12px;line-height:18px}._6YbJdq_discoveryHeading button:disabled,._6YbJdq_cardActions button:disabled{cursor:not-allowed;opacity:.58}._6YbJdq_catalogStatus{border:1px solid color-mix(in srgb, var(--dsw-alias-state-business-primary) 24%, var(--dsw-alias-border-l2));background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, var(--dsw-alias-bg-layer-1));border-radius:12px;grid-template-columns:minmax(0,1fr) auto;gap:7px 18px;padding:14px 16px;display:grid}._6YbJdq_catalogStatus>div{flex-wrap:wrap;gap:7px 12px;font-size:12px;line-height:18px;display:flex}._6YbJdq_catalogStatus strong{color:var(--dsw-alias-state-business-primary)}._6YbJdq_catalogStatus span{color:var(--dsw-alias-label-secondary)}._6YbJdq_catalogStatus code{color:var(--dsw-alias-label-tertiary);font-size:10px}._6YbJdq_catalogStatus p{color:var(--dsw-alias-label-tertiary);grid-column:1/-1;margin:0;font-size:12px;line-height:18px}._6YbJdq_discoveryControls{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:14px;flex-direction:column;gap:14px;padding:18px;display:flex}._6YbJdq_discoveryHeading{justify-content:space-between;align-items:flex-start;gap:18px;display:flex}._6YbJdq_discoveryHeading h3,._6YbJdq_discoveryHeading p,._6YbJdq_candidateCard h4,._6YbJdq_candidateCard p,._6YbJdq_detail h3,._6YbJdq_detail h4,._6YbJdq_comparison h3{margin:0}._6YbJdq_discoveryHeading h3{font-size:15px;line-height:22px}._6YbJdq_discoveryHeading p{max-width:660px;color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:12px;line-height:19px}._6YbJdq_search,._6YbJdq_filters label{color:var(--dsw-alias-label-secondary);flex-direction:column;gap:5px;font-size:11px;font-weight:600;line-height:17px;display:flex}._6YbJdq_search input,._6YbJdq_filters select{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);height:36px;color:var(--dsw-alias-label-primary);font:inherit;border-radius:9px;font-size:12px}._6YbJdq_search input{width:100%;padding:0 11px}._6YbJdq_filters{grid-template-columns:repeat(5,minmax(0,1fr));gap:10px;display:grid}._6YbJdq_filters select{width:100%;padding:0 8px}._6YbJdq_resultSummary{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px}._6YbJdq_candidateGrid{grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;display:grid}._6YbJdq_candidateCard{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:14px;flex-direction:column;gap:10px;min-width:0;padding:16px;display:flex}._6YbJdq_cardMeta{flex-wrap:wrap;gap:6px;display:flex}._6YbJdq_cardMeta span{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary);border-radius:6px;padding:2px 7px;font-size:10px;font-weight:600;line-height:16px;display:inline-flex}._6YbJdq_cardMeta span:first-child{color:var(--dsw-alias-state-business-primary)}._6YbJdq_candidateCard h4{font-size:14px;line-height:21px}._6YbJdq_candidateCard>p{min-height:57px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:19px}._6YbJdq_cardFacts,._6YbJdq_detailFacts{margin:0}._6YbJdq_cardFacts div{border-top:1px solid var(--dsw-alias-border-l2);grid-template-columns:82px minmax(0,1fr);gap:8px;padding:5px 0;font-size:11px;line-height:17px;display:grid}._6YbJdq_cardFacts dt,._6YbJdq_detailFacts dt{color:var(--dsw-alias-label-tertiary)}._6YbJdq_cardFacts dd,._6YbJdq_detailFacts dd{overflow-wrap:anywhere;min-width:0;color:var(--dsw-alias-label-secondary);margin:0}._6YbJdq_cardActions{flex-wrap:wrap;gap:6px;margin-top:auto;display:flex}._6YbJdq_cardActions button[aria-pressed=true]{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}._6YbJdq_detail,._6YbJdq_comparison{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:14px;padding:18px}._6YbJdq_detail>header,._6YbJdq_comparison>header{justify-content:space-between;align-items:flex-start;gap:18px;margin-bottom:15px;display:flex}._6YbJdq_detail header span{color:var(--dsw-alias-state-business-primary);text-transform:uppercase;font-size:10px;font-weight:600}._6YbJdq_detail h3,._6YbJdq_comparison h3{margin-top:2px;font-size:16px;line-height:23px}._6YbJdq_storeLifecycle{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:10px;gap:10px;margin-bottom:15px;padding:14px;display:grid}._6YbJdq_storeLifecycle>h4{font-size:12px;line-height:19px}._6YbJdq_storeLifecycle>._6YbJdq_candidateScope{max-width:320px;margin-top:0}._6YbJdq_detailFacts{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-border-l2);border-radius:10px;grid-template-columns:repeat(2,minmax(0,1fr));gap:1px;display:grid;overflow:hidden}._6YbJdq_detailFacts>div{background:var(--dsw-alias-bg-layer-2);min-width:0;padding:10px 12px;font-size:11px;line-height:18px}._6YbJdq_detailFacts dt{margin-bottom:3px;font-weight:600}._6YbJdq_detailFacts code,._6YbJdq_comparison code{overflow-wrap:anywhere;white-space:normal}._6YbJdq_detailFacts a{color:var(--dsw-alias-state-business-primary)}._6YbJdq_disclosure{margin-top:15px}._6YbJdq_disclosure h4{font-size:12px;line-height:19px}._6YbJdq_disclosure ul{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;margin:8px 0 0;padding:0;list-style:none;display:grid}._6YbJdq_disclosure li{background:var(--dsw-alias-bg-layer-2);border-radius:9px;flex-direction:column;gap:3px;padding:10px 12px;font-size:11px;line-height:17px;display:flex}._6YbJdq_disclosure li span{color:var(--dsw-alias-label-tertiary)}._6YbJdq_tableScroll{overflow-x:auto}._6YbJdq_comparison table{border-collapse:collapse;width:100%;min-width:700px;font-size:11px;line-height:17px}._6YbJdq_comparison th,._6YbJdq_comparison td{border:1px solid var(--dsw-alias-border-l2);vertical-align:top;text-align:left;overflow-wrap:anywhere;padding:9px 10px}._6YbJdq_comparison thead th,._6YbJdq_comparison tbody th{background:var(--dsw-alias-bg-layer-2);font-weight:600}@media (width<=760px){._6YbJdq_dialog{border-radius:18px;width:100%;height:100%}._6YbJdq_header{padding:22px 20px 16px}._6YbJdq_tabs{gap:20px;padding:0 20px;overflow-x:auto}._6YbJdq_tabs button{flex:none}._6YbJdq_panel{padding:20px}._6YbJdq_kindGrid,._6YbJdq_filters,._6YbJdq_candidateGrid,._6YbJdq_inventoryList,._6YbJdq_updateList,._6YbJdq_stateGrid,._6YbJdq_planFacts,._6YbJdq_typedConfigGrid,._6YbJdq_detailFacts,._6YbJdq_disclosure ul{grid-template-columns:minmax(0,1fr)}._6YbJdq_discoveryHeading,._6YbJdq_lifecycle{flex-direction:column;align-items:stretch}._6YbJdq_capabilityGrid{grid-template-columns:minmax(0,1fr);min-width:0}._6YbJdq_actions{justify-content:flex-start}}@media (prefers-reduced-motion:reduce){._6YbJdq_tabs button:after{transition:none}}";
		const styleTagId = "dsh-plugin-extension-center/ExtensionCenter.module.css";
		var ExtensionCenter_module_css_default = {
			"actions": "_6YbJdq_actions",
			"activityCard": "_6YbJdq_activityCard",
			"activityList": "_6YbJdq_activityList",
			"candidateCard": "_6YbJdq_candidateCard",
			"candidateGrid": "_6YbJdq_candidateGrid",
			"candidateScope": "_6YbJdq_candidateScope",
			"capabilityGrid": "_6YbJdq_capabilityGrid",
			"cardActions": "_6YbJdq_cardActions",
			"cardFacts": "_6YbJdq_cardFacts",
			"cardMeta": "_6YbJdq_cardMeta",
			"catalogLoading": "_6YbJdq_catalogLoading",
			"catalogStatus": "_6YbJdq_catalogStatus",
			"close": "_6YbJdq_close",
			"comparison": "_6YbJdq_comparison",
			"configurationDiff": "_6YbJdq_configurationDiff",
			"configurationDraft": "_6YbJdq_configurationDraft",
			"decisionActions": "_6YbJdq_decisionActions",
			"decisionResult": "_6YbJdq_decisionResult",
			"detail": "_6YbJdq_detail",
			"detailFacts": "_6YbJdq_detailFacts",
			"dialog": "_6YbJdq_dialog",
			"disclosure": "_6YbJdq_disclosure",
			"discoveryControls": "_6YbJdq_discoveryControls",
			"discoveryError": "_6YbJdq_discoveryError",
			"discoveryHeading": "_6YbJdq_discoveryHeading",
			"empty": "_6YbJdq_empty",
			"eyebrow": "_6YbJdq_eyebrow",
			"filters": "_6YbJdq_filters",
			"header": "_6YbJdq_header",
			"host": "_6YbJdq_host",
			"inlineActions": "_6YbJdq_inlineActions",
			"inventoryCard": "_6YbJdq_inventoryCard",
			"inventoryList": "_6YbJdq_inventoryList",
			"inventoryWarning": "_6YbJdq_inventoryWarning",
			"kindCard": "_6YbJdq_kindCard",
			"kindGrid": "_6YbJdq_kindGrid",
			"kindStatus": "_6YbJdq_kindStatus",
			"lifecycle": "_6YbJdq_lifecycle",
			"lifecycleActions": "_6YbJdq_lifecycleActions",
			"managementError": "_6YbJdq_managementError",
			"managementLoading": "_6YbJdq_managementLoading",
			"managementPanel": "_6YbJdq_managementPanel",
			"mutationError": "_6YbJdq_mutationError",
			"panel": "_6YbJdq_panel",
			"panelHeading": "_6YbJdq_panelHeading",
			"panels": "_6YbJdq_panels",
			"planDenied": "_6YbJdq_planDenied",
			"planFacts": "_6YbJdq_planFacts",
			"planPermissions": "_6YbJdq_planPermissions",
			"planReview": "_6YbJdq_planReview",
			"primaryAction": "_6YbJdq_primaryAction",
			"recoveryCallout": "_6YbJdq_recoveryCallout",
			"resultSummary": "_6YbJdq_resultSummary",
			"search": "_6YbJdq_search",
			"stateGrid": "_6YbJdq_stateGrid",
			"store": "_6YbJdq_store",
			"storeLifecycle": "_6YbJdq_storeLifecycle",
			"surface": "_6YbJdq_surface",
			"tableScroll": "_6YbJdq_tableScroll",
			"tabs": "_6YbJdq_tabs",
			"targetLine": "_6YbJdq_targetLine",
			"titleBlock": "_6YbJdq_titleBlock",
			"trigger": "_6YbJdq_trigger",
			"typedConfigGrid": "_6YbJdq_typedConfigGrid",
			"updateCard": "_6YbJdq_updateCard",
			"updateList": "_6YbJdq_updateList",
			"updateTarget": "_6YbJdq_updateTarget"
		};
		//#endregion
		//#region lib/.build/resolver-candidates.js
		/** Exact capability-resolver releases understood by this Extension Center build. */
		const CAPABILITY_RESOLVER_CANDIDATES = Object.freeze([Object.freeze({
			candidateRef: "plugin:dsh-capability-resolver@0.1.0",
			version: "0.1.0",
			integrity: "sha256:895e1e44ee9edaff0c4982c671379bbc3122e2c0189250e9870ee70102f2c27e",
			sizeBytes: 92128,
			configurationSchema: "dsh-capability-resolver/config@0.1.0"
		}), Object.freeze({
			candidateRef: "plugin:dsh-capability-resolver@0.1.1",
			version: "0.1.1",
			integrity: "sha256:650fab654ad7a7c22d2dd34814d8625810b67d5b6345e6ffe136c19373127c17",
			sizeBytes: 92419,
			configurationSchema: "dsh-capability-resolver/config@0.1.1"
		})]);
		/** Whether a candidate reference names one exact supported capability-resolver release. */
		function isCapabilityResolverCandidate(candidateRef) {
			return CAPABILITY_RESOLVER_CANDIDATES.some((candidate) => candidate.candidateRef === candidateRef);
		}
		//#endregion
		//#region lib/.build/client/HostCapabilityStatus.js
		const HOST_CAPABILITIES = [
			["managedPluginLifecycle", "capability.managedPluginLifecycle"],
			["dynamicMcpConnection", "capability.dynamicMcpConnection"],
			["durableContinuation", "capability.durableContinuation"],
			["skillRegistry", "capability.skillRegistry"],
			["toolRegistry", "capability.toolRegistry"],
			["loaderMutation", "capability.loaderMutation"]
		];
		/** Render every independent writable-Host preflight fact. */
		function HostCapabilityStatus({ capabilities, t }) {
			return (0, react_jsx_runtime.jsx)("dl", {
				className: ExtensionCenter_module_css_default.capabilityGrid,
				"aria-label": t("capability.heading"),
				children: HOST_CAPABILITIES.map(([key, label]) => (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t(label) }), (0, react_jsx_runtime.jsx)("dd", {
					"data-capability-status": capabilities[key] ? "ready" : "missing",
					children: capabilities[key] ? t("capability.ready") : t("capability.missing")
				})] }, key))
			});
		}
		//#endregion
		//#region lib/.build/catalog-contract.js
		/** Logical Connection-authenticated browser RPC channel owned by this plugin. */
		const EXTENSION_CENTER_RPC_CHANNEL = "/dsh-extension-center";
		//#endregion
		//#region lib/.build/plans/pnpm-runtime.js
		/** Exact bundled pnpm identity emitted by the current writable generation. */
		const CURRENT_PNPM_EXECUTION_IDENTITY = Object.freeze({
			packageVersion: "11.21.0",
			registryIntegrity: "sha512-UhcFvOaJkk6scvWjWHEi82JonvZXHlW6gAdv1jfBETLs/62ib61Op5xIW/3b/T1aKlsFgFp36JPeceyKbMo7sQ=="
		});
		/** Retired pnpm identity accepted only while reading rc.0 durable history. */
		const RETIRED_PNPM_EXECUTION_IDENTITY = Object.freeze({
			packageVersion: "11.7.0",
			registryIntegrity: "sha512-GcyFLBIMcSV2DyRD7mvgyltA+fUFmN4aCaHxd1A+AQ5Xwjx3ZG4B52HeWb+HT7IqM5jDOrlpH8E+uUa28PTWIA=="
		});
		/**
		* Test whether a version and SRI name the current writable pnpm runtime.
		* @param value Candidate package identity.
		* @returns Whether both fields equal the current pinned pair.
		*/
		function isCurrentPnpmExecutionIdentity(value) {
			return value.packageVersion === CURRENT_PNPM_EXECUTION_IDENTITY.packageVersion && value.registryIntegrity === CURRENT_PNPM_EXECUTION_IDENTITY.registryIntegrity;
		}
		/**
		* Test whether a version and SRI name one exact current or retired durable identity.
		* @param value Candidate package identity.
		* @returns Whether the fields equal one recognized pair without mixing generations.
		*/
		function isReadablePnpmExecutionIdentity(value) {
			return isCurrentPnpmExecutionIdentity(value) || value.packageVersion === RETIRED_PNPM_EXECUTION_IDENTITY.packageVersion && value.registryIntegrity === RETIRED_PNPM_EXECUTION_IDENTITY.registryIntegrity;
		}
		//#endregion
		//#region lib/.build/client/catalog-api.js
		const MAX_RESPONSE_BYTES$1 = 512 * 1024;
		const MAX_ENTRIES = 100;
		const MAX_STRING$1 = 4096;
		const EXTENSION_KINDS = /* @__PURE__ */ new Set([
			"plugin",
			"mcp",
			"skill"
		]);
		const SOURCE_TYPES = /* @__PURE__ */ new Set([
			"github-release",
			"mcp-registry",
			"github-content"
		]);
		const PUBLISHER_STATUSES = /* @__PURE__ */ new Set(["community", "upstream-registry"]);
		const LICENSE_STATUSES = /* @__PURE__ */ new Set([
			"verified",
			"publisher-declared",
			"unknown"
		]);
		const COMPATIBILITY_STATUSES = /* @__PURE__ */ new Set(["compatible", "review-required"]);
		const PLATFORMS = /* @__PURE__ */ new Set([
			"darwin",
			"linux",
			"windows"
		]);
		const PERMISSION_PHASES = /* @__PURE__ */ new Set(["acquisition", "runtime"]);
		const PERMISSION_KINDS = /* @__PURE__ */ new Set([
			"network",
			"filesystem",
			"subprocess",
			"credentials",
			"model-context"
		]);
		const PERMISSION_ACCESS = /* @__PURE__ */ new Set([
			"none",
			"read",
			"write",
			"execute",
			"send"
		]);
		const DEPENDENCY_KINDS = /* @__PURE__ */ new Set([
			"host",
			"runtime",
			"extension"
		]);
		const SCOPES = /* @__PURE__ */ new Set([
			"profile:web",
			"user",
			"project"
		]);
		const CREDENTIAL_STATES = /* @__PURE__ */ new Set([
			"none",
			"optional",
			"required"
		]);
		const VERIFICATION_STATES = /* @__PURE__ */ new Set([
			"verified",
			"declared",
			"unknown"
		]);
		/** Error returned through a valid Connection RPC business-failure envelope. */
		var ExtensionCenterRpcError = class extends Error {
			code;
			/** @param error - Connection RPC error already validated by the carrier. */
			constructor(error) {
				super(error.message);
				this.name = "ExtensionCenterRpcError";
				this.code = error.code;
			}
		};
		function expectRecord(value, subject, keys) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`extension-center: invalid ${subject}`);
			const record = value;
			const actual = Object.keys(record).sort();
			const expected = [...keys].sort();
			if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`extension-center: unexpected fields in ${subject}`);
			return record;
		}
		function expectString(value, subject, maxLength = MAX_STRING$1) {
			if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw new Error(`extension-center: invalid ${subject}`);
			return value;
		}
		function expectBoolean(value, subject) {
			if (typeof value !== "boolean") throw new Error(`extension-center: invalid ${subject}`);
			return value;
		}
		function expectSafeInteger(value, subject, minimum = 0) {
			if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`extension-center: invalid ${subject}`);
			return value;
		}
		function expectArray(value, subject, maxItems) {
			if (!Array.isArray(value) || value.length > maxItems) throw new Error(`extension-center: invalid ${subject}`);
			return value;
		}
		function expectEnum(value, subject, allowed) {
			const result = expectString(value, subject, 128);
			if (!allowed.has(result)) throw new Error(`extension-center: invalid ${subject}`);
			return result;
		}
		function expectHttpsUrl(value, subject) {
			const result = expectString(value, subject, 2048);
			let url;
			try {
				url = new URL(result);
			} catch {
				throw new Error(`extension-center: invalid ${subject}`);
			}
			if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new Error(`extension-center: invalid ${subject}`);
			return result;
		}
		function expectIntegrity(value, subject) {
			const result = expectString(value, subject, 512);
			const validSha256 = /^sha256:[a-f0-9]{64}$/.test(result);
			const validSha512 = /^sha512:[A-Za-z0-9+/]{86}==$/.test(result);
			if (!validSha256 && !validSha512) throw new Error(`extension-center: invalid ${subject}`);
			return result;
		}
		function validateLocalized(value, subject) {
			const input = expectRecord(value, subject, ["en", "zh"]);
			expectString(input.en, `${subject}.en`, 1500);
			expectString(input.zh, `${subject}.zh`, 1500);
			return input;
		}
		function validateLifecycleAction(value, subject) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`extension-center: invalid ${subject}`);
			const status = expectEnum(value.status, `${subject}.status`, /* @__PURE__ */ new Set(["available", "unavailable"]));
			const input = expectRecord(value, subject, status === "available" ? ["status"] : ["reason", "status"]);
			if (status === "unavailable") expectString(input.reason, `${subject}.reason`, 128);
			return input;
		}
		function validateEntry(value, index) {
			const subject = `catalog entry ${index}`;
			const input = expectRecord(value, subject, [
				"artifact",
				"candidateRef",
				"compatibility",
				"components",
				"configuration",
				"conflicts",
				"dependencies",
				"displayName",
				"kind",
				"license",
				"lifecycle",
				"name",
				"permissions",
				"publisher",
				"restart",
				"retainedData",
				"scopes",
				"source",
				"summary",
				"tags",
				"verification"
			]);
			const kind = expectEnum(input.kind, `${subject}.kind`, EXTENSION_KINDS);
			if (!expectString(input.candidateRef, `${subject}.candidateRef`, 512).startsWith(`${kind}:`)) throw new Error(`extension-center: invalid ${subject}.candidateRef`);
			expectString(input.name, `${subject}.name`, 256);
			validateLocalized(input.displayName, `${subject}.displayName`);
			validateLocalized(input.summary, `${subject}.summary`);
			const publisher = expectRecord(input.publisher, `${subject}.publisher`, ["name", "status"]);
			expectString(publisher.name, `${subject}.publisher.name`, 256);
			expectEnum(publisher.status, `${subject}.publisher.status`, PUBLISHER_STATUSES);
			const license = expectRecord(input.license, `${subject}.license`, [
				"sourceUrl",
				"spdx",
				"status"
			]);
			if (expectEnum(license.status, `${subject}.license.status`, LICENSE_STATUSES) === "unknown") {
				if (license.spdx !== null || license.sourceUrl !== null) throw new Error(`extension-center: invalid ${subject}.license evidence`);
			} else {
				expectString(license.spdx, `${subject}.license.spdx`, 256);
				expectHttpsUrl(license.sourceUrl, `${subject}.license.sourceUrl`);
			}
			const source = expectRecord(input.source, `${subject}.source`, [
				"admittedAt",
				"label",
				"revision",
				"type",
				"upstreamUrl",
				"url"
			]);
			expectEnum(source.type, `${subject}.source.type`, SOURCE_TYPES);
			expectString(source.label, `${subject}.source.label`, 256);
			expectHttpsUrl(source.url, `${subject}.source.url`);
			expectHttpsUrl(source.upstreamUrl, `${subject}.source.upstreamUrl`);
			const revision = expectString(source.revision, `${subject}.source.revision`, 256);
			if (revision === "main" || revision === "master" || revision === "latest") throw new Error(`extension-center: moving ${subject}.source.revision`);
			if (!Number.isFinite(Date.parse(expectString(source.admittedAt, `${subject}.source.admittedAt`, 64)))) throw new Error(`extension-center: invalid ${subject}.source.admittedAt`);
			const artifact = expectRecord(input.artifact, `${subject}.artifact`, [
				"acquisitionUrl",
				"id",
				"integrity",
				"sizeBytes",
				"version"
			]);
			expectString(artifact.id, `${subject}.artifact.id`, 512);
			const version = expectString(artifact.version, `${subject}.artifact.version`, 256);
			if (version === "latest" || version === "main" || version === "master") throw new Error(`extension-center: moving ${subject}.artifact.version`);
			expectIntegrity(artifact.integrity, `${subject}.artifact.integrity`);
			expectSafeInteger(artifact.sizeBytes, `${subject}.artifact.sizeBytes`, 1);
			expectHttpsUrl(artifact.acquisitionUrl, `${subject}.artifact.acquisitionUrl`);
			const compatibility = expectRecord(input.compatibility, `${subject}.compatibility`, [
				"detail",
				"dsh",
				"platforms",
				"status"
			]);
			expectEnum(compatibility.status, `${subject}.compatibility.status`, COMPATIBILITY_STATUSES);
			if (!["0.1.1-rc.2", "0.1.2-alpha.1"].includes(compatibility.dsh)) throw new Error(`extension-center: invalid ${subject}.compatibility.dsh`);
			const platforms = expectArray(compatibility.platforms, `${subject}.compatibility.platforms`, 3);
			if (platforms.length === 0) throw new Error(`extension-center: empty ${subject}.compatibility.platforms`);
			platforms.forEach((platform, at) => {
				expectEnum(platform, `${subject}.compatibility.platforms[${at}]`, PLATFORMS);
			});
			validateLocalized(compatibility.detail, `${subject}.compatibility.detail`);
			expectArray(input.components, `${subject}.components`, 30).forEach((component, at) => {
				validateLocalized(component, `${subject}.components[${at}]`);
			});
			expectArray(input.permissions, `${subject}.permissions`, 30).forEach((permission, at) => {
				const row = expectRecord(permission, `${subject}.permissions[${at}]`, [
					"access",
					"detail",
					"kind",
					"phase"
				]);
				expectEnum(row.phase, `${subject}.permissions[${at}].phase`, PERMISSION_PHASES);
				expectEnum(row.kind, `${subject}.permissions[${at}].kind`, PERMISSION_KINDS);
				expectEnum(row.access, `${subject}.permissions[${at}].access`, PERMISSION_ACCESS);
				validateLocalized(row.detail, `${subject}.permissions[${at}].detail`);
			});
			expectArray(input.dependencies, `${subject}.dependencies`, 30).forEach((dependency, at) => {
				const row = expectRecord(dependency, `${subject}.dependencies[${at}]`, [
					"id",
					"kind",
					"required",
					"version"
				]);
				expectEnum(row.kind, `${subject}.dependencies[${at}].kind`, DEPENDENCY_KINDS);
				expectString(row.id, `${subject}.dependencies[${at}].id`, 512);
				expectString(row.version, `${subject}.dependencies[${at}].version`, 256);
				expectBoolean(row.required, `${subject}.dependencies[${at}].required`);
			});
			const scopes = expectArray(input.scopes, `${subject}.scopes`, 3);
			if (scopes.length === 0) throw new Error(`extension-center: empty ${subject}.scopes`);
			scopes.forEach((scope, at) => {
				expectEnum(scope, `${subject}.scopes[${at}]`, SCOPES);
			});
			const configuration = expectRecord(input.configuration, `${subject}.configuration`, [
				"credentials",
				"fields",
				"required"
			]);
			expectBoolean(configuration.required, `${subject}.configuration.required`);
			expectEnum(configuration.credentials, `${subject}.configuration.credentials`, CREDENTIAL_STATES);
			expectArray(configuration.fields, `${subject}.configuration.fields`, 30).forEach((field, at) => {
				validateLocalized(field, `${subject}.configuration.fields[${at}]`);
			});
			expectArray(input.conflicts, `${subject}.conflicts`, 30).forEach((conflict, at) => {
				validateLocalized(conflict, `${subject}.conflicts[${at}]`);
			});
			const restart = expectRecord(input.restart, `${subject}.restart`, ["detail", "required"]);
			expectBoolean(restart.required, `${subject}.restart.required`);
			validateLocalized(restart.detail, `${subject}.restart.detail`);
			const lifecycle = expectRecord(input.lifecycle, `${subject}.lifecycle`, [
				"configure",
				"install",
				"restore",
				"uninstall",
				"update"
			]);
			for (const action of [
				"install",
				"configure",
				"update",
				"uninstall",
				"restore"
			]) validateLifecycleAction(lifecycle[action], `${subject}.lifecycle.${action}`);
			expectArray(input.verification, `${subject}.verification`, 30).forEach((verification, at) => {
				const row = expectRecord(verification, `${subject}.verification[${at}]`, [
					"claim",
					"detail",
					"status"
				]);
				validateLocalized(row.claim, `${subject}.verification[${at}].claim`);
				expectEnum(row.status, `${subject}.verification[${at}].status`, VERIFICATION_STATES);
				validateLocalized(row.detail, `${subject}.verification[${at}].detail`);
			});
			validateLocalized(input.retainedData, `${subject}.retainedData`);
			expectArray(input.tags, `${subject}.tags`, 30).forEach((tag, at) => {
				expectString(tag, `${subject}.tags[${at}]`, 80);
			});
			return input;
		}
		/** Deeply validate a Host catalog response before rendering any field. */
		function parseCatalogListResponse(value) {
			let encoded;
			try {
				encoded = JSON.stringify(value);
			} catch {
				throw new Error("extension-center: catalog response is not JSON-compatible");
			}
			if (new TextEncoder().encode(encoded).byteLength > MAX_RESPONSE_BYTES$1) throw new Error("extension-center: catalog response is oversized");
			const input = expectRecord(value, "catalog response", [
				"catalog",
				"entries",
				"hostCapabilities",
				"protocolVersion"
			]);
			if (input.protocolVersion !== 1) throw new Error("extension-center: incompatible protocol version");
			const catalog = expectRecord(input.catalog, "catalog response.catalog", [
				"degraded",
				"degradedReason",
				"entriesDigest",
				"expiresAt",
				"freshness",
				"id",
				"issuedAt",
				"keyIds",
				"lastRefreshAtMs",
				"revision",
				"signatureStatus",
				"source"
			]);
			expectString(catalog.id, "catalog response.catalog.id", 256);
			expectSafeInteger(catalog.revision, "catalog response.catalog.revision", 1);
			const issuedAt = Date.parse(expectString(catalog.issuedAt, "catalog response.catalog.issuedAt", 64));
			const expiresAt = Date.parse(expectString(catalog.expiresAt, "catalog response.catalog.expiresAt", 64));
			for (const [field, timestamp] of [["issuedAt", issuedAt], ["expiresAt", expiresAt]]) if (!Number.isFinite(timestamp)) throw new Error(`extension-center: invalid catalog response.catalog.${field}`);
			if (issuedAt >= expiresAt || Date.now() < issuedAt || Date.now() >= expiresAt) throw new Error("extension-center: catalog response is outside its validity interval");
			if (!/^sha256:[a-f0-9]{64}$/.test(expectString(catalog.entriesDigest, "catalog response.catalog.entriesDigest", 72))) throw new Error("extension-center: invalid catalog response.catalog.entriesDigest");
			if (catalog.signatureStatus !== "verified") throw new Error("extension-center: catalog signature is not verified");
			expectEnum(catalog.source, "catalog response.catalog.source", /* @__PURE__ */ new Set([
				"bootstrap",
				"remote",
				"last-good"
			]));
			expectEnum(catalog.freshness, "catalog response.catalog.freshness", /* @__PURE__ */ new Set([
				"bootstrap",
				"fresh",
				"cached"
			]));
			if (expectBoolean(catalog.degraded, "catalog response.catalog.degraded")) expectString(catalog.degradedReason, "catalog response.catalog.degradedReason", 160);
			else if (catalog.degradedReason !== null) throw new Error("extension-center: invalid catalog degraded reason");
			if (catalog.lastRefreshAtMs !== null) expectSafeInteger(catalog.lastRefreshAtMs, "catalog response.catalog.lastRefreshAtMs");
			const keyIds = expectArray(catalog.keyIds, "catalog response.catalog.keyIds", 10);
			if (keyIds.length === 0) throw new Error("extension-center: catalog response has no verified signing key");
			keyIds.forEach((key, at) => {
				expectString(key, `catalog response.catalog.keyIds[${at}]`, 128);
			});
			const capabilities = expectRecord(input.hostCapabilities, "catalog response.hostCapabilities", [
				"acquisition",
				"durableContinuation",
				"dynamicMcpConnection",
				"loaderMutation",
				"managedPluginLifecycle",
				"reason",
				"skillRegistry",
				"toolRegistry"
			]);
			const managedPluginLifecycle = expectBoolean(capabilities.managedPluginLifecycle, "catalog response.hostCapabilities.managedPluginLifecycle");
			const dynamicMcpConnection = expectBoolean(capabilities.dynamicMcpConnection, "catalog response.hostCapabilities.dynamicMcpConnection");
			const durableContinuation = expectBoolean(capabilities.durableContinuation, "catalog response.hostCapabilities.durableContinuation");
			const skillRegistry = expectBoolean(capabilities.skillRegistry, "catalog response.hostCapabilities.skillRegistry");
			const toolRegistry = expectBoolean(capabilities.toolRegistry, "catalog response.hostCapabilities.toolRegistry");
			const loaderMutation = expectBoolean(capabilities.loaderMutation, "catalog response.hostCapabilities.loaderMutation");
			const acquisition = expectBoolean(capabilities.acquisition, "catalog response.hostCapabilities.acquisition");
			if (acquisition && !(managedPluginLifecycle && dynamicMcpConnection && durableContinuation && skillRegistry && toolRegistry && loaderMutation)) throw new Error("extension-center: Host acquisition claim requires all owners and a ready writable runtime");
			const expectedReason = acquisition ? null : "host-capability";
			if (capabilities.reason !== expectedReason) throw new Error("extension-center: invalid Host capability reason");
			const entries = expectArray(input.entries, "catalog response.entries", MAX_ENTRIES).map((entry, index) => validateEntry(entry, index));
			const refs = /* @__PURE__ */ new Set();
			for (const entry of entries) {
				if (refs.has(entry.candidateRef)) throw new Error(`extension-center: duplicate candidateRef ${entry.candidateRef}`);
				refs.add(entry.candidateRef);
			}
			return input;
		}
		/** Create a stateless Store catalog client over the generic Connection carrier. */
		function createExtensionCatalogClient(rpc) {
			const call = async (endpoint, signal) => {
				const result = await rpc.call(EXTENSION_CENTER_RPC_CHANNEL, endpoint, { protocolVersion: 1 }, signal);
				if (!result.ok) throw new ExtensionCenterRpcError(result.error);
				return parseCatalogListResponse(result.value);
			};
			return {
				list: (signal) => call("catalog/list", signal),
				refresh: (signal) => call("catalog/refresh", signal)
			};
		}
		//#endregion
		//#region lib/.build/client/management-api.js
		const PROTOCOL_VERSION = 1;
		const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
		const MAX_STRING = 4096;
		const MAX_ROWS = 1e3;
		const MAX_OPERATIONS = 2e3;
		const MAX_TIMESTAMP = 864e13;
		const SHA256 = /^sha256:[0-9a-f]{64}$/;
		const ARTIFACT_INTEGRITY = /^(?:sha256:[0-9a-f]{64}|sha512:(?:[0-9a-f]{128}|[A-Za-z0-9+/]{86}==))$/;
		const OPERATIONS = /* @__PURE__ */ new Set([
			"install",
			"configure",
			"update",
			"enable",
			"disable",
			"uninstall",
			"restore",
			"purge"
		]);
		const MANAGED_OBJECTS = /* @__PURE__ */ new Set(["artifact", "connection"]);
		const EXTERNAL_RUNTIME_ACTIONS = /* @__PURE__ */ new Set(["download", "none"]);
		const TASK_ATTEMPT = /^task-attempt:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		const RESOLUTION = /^resolution:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		const CANDIDATE = /^(?:plugin|mcp|skill):[A-Za-z0-9@._:/-]{1,240}$/;
		const EXTENSION_REF = /^extension-ref:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
		function fail(subject) {
			throw new Error(`extension-center: invalid ${subject}`);
		}
		function exactRecord(value, subject, keys) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) fail(subject);
			const record = value;
			const actual = Object.keys(record).sort();
			const expected = [...keys].sort();
			if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(`extension-center: unexpected fields in ${subject}`);
			return record;
		}
		function string(value, subject, maximum = MAX_STRING) {
			if (typeof value !== "string" || value.length === 0 || value.length > maximum) fail(subject);
			return value;
		}
		function nullableString(value, subject) {
			return value === null ? null : string(value, subject);
		}
		function bool(value, subject) {
			if (typeof value !== "boolean") fail(subject);
			return value;
		}
		function integer$1(value, subject) {
			if (!Number.isSafeInteger(value) || value < 0) fail(subject);
			return value;
		}
		function timestamp(value, subject) {
			const result = integer$1(value, subject);
			if (result > MAX_TIMESTAMP) fail(subject);
			return result;
		}
		function literal(value, values, subject) {
			const result = string(value, subject, 128);
			if (!values.has(result)) fail(subject);
			return result;
		}
		function array(value, subject, maximum) {
			if (!Array.isArray(value) || value.length > maximum) fail(subject);
			return value;
		}
		function rpcJson(value, subject, depth = 0, count = { value: 0 }) {
			count.value += 1;
			if (count.value > 4096 || depth > 16) fail(subject);
			if (value === null || typeof value === "boolean") return value;
			if (typeof value === "number") {
				if (!Number.isFinite(value)) fail(subject);
				return value;
			}
			if (typeof value === "string") {
				if (value.length > 16384 || value.includes("\0")) fail(subject);
				return value;
			}
			if (Array.isArray(value)) return value.map((item) => rpcJson(item, subject, depth + 1, count));
			if (typeof value !== "object") fail(subject);
			const output = {};
			for (const key of Object.keys(value).sort()) {
				if (key.length === 0 || key.length > 128 || key.includes("\0")) fail(subject);
				output[key] = rpcJson(value[key], subject, depth + 1, count);
			}
			return output;
		}
		function digest(value, subject) {
			const result = string(value, subject, 80);
			if (!SHA256.test(result)) fail(subject);
			return result;
		}
		function absolutePath$1(value, subject) {
			const path = string(value, subject, 4096);
			if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/u.test(path) && !path.startsWith("\\\\")) fail(subject);
			return path;
		}
		function integrity(value, subject) {
			const result = string(value, subject, 180);
			if (!ARTIFACT_INTEGRITY.test(result)) fail(subject);
			return result;
		}
		function runtimeBinding(value, subject) {
			if (value === null) return null;
			const input = exactRecord(value, subject, [
				"runtimeRef",
				"version",
				"descriptorDigest"
			]);
			return {
				runtimeRef: string(input.runtimeRef, `${subject}.runtimeRef`, 256),
				version: string(input.version, `${subject}.version`, 128),
				descriptorDigest: digest(input.descriptorDigest, `${subject}.descriptorDigest`)
			};
		}
		function managedObjectBinding(value, subject) {
			const managedObject = literal(value.managedObject, MANAGED_OBJECTS, `${subject}.managedObject`);
			const externalRuntimeAction = literal(value.externalRuntimeAction, EXTERNAL_RUNTIME_ACTIONS, `${subject}.externalRuntimeAction`);
			const binding = runtimeBinding(value.runtimeBinding, `${subject}.runtimeBinding`);
			if (managedObject === "connection") {
				if (externalRuntimeAction !== "none" || binding === null) fail(subject);
			} else {
				const operationKind = literal(value.operationKind, OPERATIONS, `${subject}.operationKind`);
				if (binding !== null || externalRuntimeAction !== (operationKind === "install" || operationKind === "update" ? "download" : "none")) fail(subject);
			}
			return {
				managedObject,
				externalRuntimeAction,
				runtimeBinding: binding
			};
		}
		function reviewStringArray(value, subject, maximum = 512) {
			const values = array(value, subject, maximum);
			values.forEach((item, index) => {
				string(item, `${subject}[${String(index)}]`, 4096);
			});
			if (new Set(values).size !== values.length) fail(`${subject} duplicates`);
		}
		function reviewEvidence(value, subject) {
			const kind = literal(value?.kind, /* @__PURE__ */ new Set([
				"plugin",
				"mcp",
				"skill"
			]), `${subject}.kind`);
			const base = [
				"schemaVersion",
				"kind",
				"operationKind",
				"checks",
				"removed",
				"retained",
				"credentialChoice",
				"rollbackPoint",
				"rollbackLimits",
				"notProven"
			];
			const input = exactRecord(value, subject, kind === "plugin" ? [
				...base,
				"manifest",
				"dependencies",
				"managedMaterial",
				"packageMetadata",
				"activation",
				"scripts",
				"settings"
			] : kind === "skill" ? [
				...base,
				"files",
				"body",
				"invocation"
			] : [
				...base,
				"descriptor",
				"runtime",
				"credentials",
				"dataEgress"
			]);
			if (input.schemaVersion !== 1) fail(`${subject}.schemaVersion`);
			const operationKind = literal(input.operationKind, OPERATIONS, `${subject}.operationKind`);
			let restartRequired = null;
			literal(input.credentialChoice, /* @__PURE__ */ new Set([
				"not-applicable",
				"retain-local-record",
				"delete-local-record"
			]), `${subject}.credentialChoice`);
			const checkCodes = /* @__PURE__ */ new Set([
				"catalog-admission",
				"owner-revision",
				"review-record",
				"artifact-integrity",
				"plugin-manifest",
				"plugin-dependencies",
				"plugin-lifecycle-scripts",
				"plugin-package-metadata",
				"plugin-settings-schema",
				"center-plugin-material",
				"official-profile-package",
				"loader-consumer",
				"host-restart-observation",
				"skill-file-manifest",
				"skill-frontmatter",
				"skill-body",
				"skill-links",
				"skill-executables",
				"invocation-policy",
				"merged-skill-winner",
				"mcp-runtime-integrity",
				"mcp-descriptor",
				"mcp-secret-absence",
				"mcp-initialize",
				"mcp-tools-list",
				"mcp-tool-generation",
				"owner-mutation",
				"owner-absence",
				"quiescent-disposal"
			]);
			const checkRows = array(input.checks, `${subject}.checks`, 64);
			checkRows.forEach((item, index) => {
				const row = exactRecord(item, `${subject}.checks[${String(index)}]`, ["code", "phase"]);
				literal(row.code, checkCodes, `${subject}.checks[${String(index)}].code`);
				literal(row.phase, /* @__PURE__ */ new Set([
					"planning",
					"prepare",
					"apply",
					"verify",
					"external-restart"
				]), `${subject}.checks[${String(index)}].phase`);
			});
			if (checkRows.length === 0) fail(`${subject}.checks`);
			for (const field of ["removed", "retained"]) array(input[field], `${subject}.${field}`, 128).forEach((item, index) => {
				const row = exactRecord(item, `${subject}.${field}[${String(index)}]`, [
					"kind",
					"id",
					"digest"
				]);
				literal(row.kind, /* @__PURE__ */ new Set([
					"center-plugin-material",
					"profile-dependency",
					"loader-entry",
					"plugin-settings",
					"skill-file",
					"connection-row",
					"credential-record",
					"external-runtime",
					"remote-data",
					"recovery-point"
				]), `${subject}.${field}[${String(index)}].kind`);
				string(row.id, `${subject}.${field}[${String(index)}].id`);
				if (row.digest !== null) digest(row.digest, `${subject}.${field}[${String(index)}].digest`);
			});
			if (input.rollbackPoint !== null) {
				const point = exactRecord(input.rollbackPoint, `${subject}.rollbackPoint`, [
					"kind",
					"id",
					"digest"
				]);
				literal(point.kind, /* @__PURE__ */ new Set(["absent-state", "managed-version"]), `${subject}.rollbackPoint.kind`);
				string(point.id, `${subject}.rollbackPoint.id`);
				digest(point.digest, `${subject}.rollbackPoint.digest`);
			}
			reviewStringArray(input.rollbackLimits, `${subject}.rollbackLimits`);
			reviewStringArray(input.notProven, `${subject}.notProven`);
			if (kind === "plugin") {
				const manifest = exactRecord(input.manifest, `${subject}.manifest`, [
					"packageName",
					"beforeVersion",
					"afterVersion",
					"body",
					"manifestDigest",
					"files",
					"fileManifestDigest"
				]);
				string(manifest.packageName, `${subject}.manifest.packageName`);
				nullableString(manifest.beforeVersion, `${subject}.manifest.beforeVersion`);
				nullableString(manifest.afterVersion, `${subject}.manifest.afterVersion`);
				string(manifest.body, `${subject}.manifest.body`, 1024 * 1024);
				digest(manifest.manifestDigest, `${subject}.manifest.manifestDigest`);
				digest(manifest.fileManifestDigest, `${subject}.manifest.fileManifestDigest`);
				reviewStringArray(manifest.files, `${subject}.manifest.files`, 4096);
				array(input.dependencies, `${subject}.dependencies`, 256).forEach((item, index) => {
					const row = exactRecord(item, `${subject}.dependencies[${String(index)}]`, [
						"kind",
						"id",
						"beforeVersion",
						"afterVersion",
						"required"
					]);
					literal(row.kind, /* @__PURE__ */ new Set([
						"host",
						"runtime",
						"extension",
						"peer"
					]), `${subject}.dependencies[${String(index)}].kind`);
					string(row.id, `${subject}.dependencies[${String(index)}].id`);
					nullableString(row.beforeVersion, `${subject}.dependencies[${String(index)}].beforeVersion`);
					nullableString(row.afterVersion, `${subject}.dependencies[${String(index)}].afterVersion`);
					bool(row.required, `${subject}.dependencies[${String(index)}].required`);
				});
				const managedMaterial = exactRecord(input.managedMaterial, `${subject}.managedMaterial`, [
					"owner",
					"packageName",
					"beforeVersion",
					"afterVersion",
					"targetIntegrity"
				]);
				literal(managedMaterial.owner, /* @__PURE__ */ new Set(["extension-center"]), `${subject}.managedMaterial.owner`);
				string(managedMaterial.packageName, `${subject}.managedMaterial.packageName`);
				nullableString(managedMaterial.beforeVersion, `${subject}.managedMaterial.beforeVersion`);
				nullableString(managedMaterial.afterVersion, `${subject}.managedMaterial.afterVersion`);
				if (managedMaterial.targetIntegrity !== null) integrity(managedMaterial.targetIntegrity, `${subject}.managedMaterial.targetIntegrity`);
				const packageMetadata = exactRecord(input.packageMetadata, `${subject}.packageMetadata`, ["bundlePatch"]);
				if (packageMetadata.bundlePatch !== null) {
					const patch = exactRecord(packageMetadata.bundlePatch, `${subject}.packageMetadata.bundlePatch`, [
						"path",
						"patchDigest",
						"patchBody"
					]);
					if (patch.path !== "cordis.patch.yml") fail(`${subject}.packageMetadata.bundlePatch.path`);
					digest(patch.patchDigest, `${subject}.packageMetadata.bundlePatch.patchDigest`);
					string(patch.patchBody, `${subject}.packageMetadata.bundlePatch.patchBody`, 1024 * 1024);
				}
				const activation = exactRecord(input.activation, `${subject}.activation`, [
					"mutationOwner",
					"profileDependency",
					"loaderEntry",
					"restartRequired",
					"packageName"
				]);
				literal(activation.mutationOwner, /* @__PURE__ */ new Set(["official-dsh-cli", "official-loader"]), `${subject}.activation.mutationOwner`);
				literal(activation.profileDependency, /* @__PURE__ */ new Set([
					"add",
					"replace",
					"remove",
					"restore",
					"retain"
				]), `${subject}.activation.profileDependency`);
				literal(activation.loaderEntry, /* @__PURE__ */ new Set([
					"create",
					"replace",
					"remove",
					"restore",
					"retain"
				]), `${subject}.activation.loaderEntry`);
				const activationRestartRequired = bool(activation.restartRequired, `${subject}.activation.restartRequired`);
				string(activation.packageName, `${subject}.activation.packageName`);
				const expectedActivation = {
					install: {
						mutationOwner: "official-dsh-cli",
						profileDependency: "add",
						loaderEntry: "create",
						restartRequired: true
					},
					configure: {
						mutationOwner: "official-loader",
						profileDependency: "retain",
						loaderEntry: "replace",
						restartRequired: false
					},
					update: {
						mutationOwner: "official-dsh-cli",
						profileDependency: "replace",
						loaderEntry: "replace",
						restartRequired: true
					},
					uninstall: {
						mutationOwner: "official-dsh-cli",
						profileDependency: "remove",
						loaderEntry: "remove",
						restartRequired: true
					},
					restore: {
						mutationOwner: "official-dsh-cli",
						profileDependency: "restore",
						loaderEntry: "restore",
						restartRequired: true
					}
				}[operationKind];
				if (expectedActivation === void 0 || activation.mutationOwner !== expectedActivation.mutationOwner || activation.profileDependency !== expectedActivation.profileDependency || activation.loaderEntry !== expectedActivation.loaderEntry || activationRestartRequired !== expectedActivation.restartRequired) fail(`${subject}.activation operation binding`);
				restartRequired = activationRestartRequired;
				const scripts = exactRecord(input.scripts, `${subject}.scripts`, [
					"before",
					"after",
					"forbiddenLifecycle"
				]);
				reviewStringArray(scripts.before, `${subject}.scripts.before`);
				reviewStringArray(scripts.after, `${subject}.scripts.after`);
				reviewStringArray(scripts.forbiddenLifecycle, `${subject}.scripts.forbiddenLifecycle`);
				const settings = exactRecord(input.settings, `${subject}.settings`, [
					"adapterVersion",
					"adapterDigest",
					"schemaDigest",
					"ownerRevision",
					"migration",
					"schema",
					"migrationChanges",
					"diffDigest"
				]);
				nullableString(settings.adapterVersion, `${subject}.settings.adapterVersion`);
				if (settings.adapterDigest !== null) digest(settings.adapterDigest, `${subject}.settings.adapterDigest`);
				if (settings.schemaDigest !== null) digest(settings.schemaDigest, `${subject}.settings.schemaDigest`);
				string(settings.ownerRevision, `${subject}.settings.ownerRevision`);
				literal(settings.migration, /* @__PURE__ */ new Set([
					"not-required",
					"validated",
					"pending"
				]), `${subject}.settings.migration`);
				array(settings.schema, `${subject}.settings.schema`, 128).forEach((item, index) => {
					const row = exactRecord(item, `${subject}.settings.schema[${String(index)}]`, [
						"field",
						"type",
						"minimum",
						"maximum"
					]);
					string(row.field, `${subject}.settings.schema[${String(index)}].field`);
					if (row.type !== "integer") fail(`${subject}.settings.schema[${String(index)}].type`);
					if (integer$1(row.minimum, `${subject}.settings.schema[${String(index)}].minimum`) > integer$1(row.maximum, `${subject}.settings.schema[${String(index)}].maximum`)) fail(`${subject}.settings.schema`);
				});
				reviewStringArray(settings.migrationChanges, `${subject}.settings.migrationChanges`);
				digest(settings.diffDigest, `${subject}.settings.diffDigest`);
			} else if (kind === "skill") {
				array(input.files, `${subject}.files`, 4096).forEach((item, index) => {
					const row = exactRecord(item, `${subject}.files[${String(index)}]`, [
						"path",
						"change",
						"beforeDigest",
						"afterDigest",
						"sizeBytes",
						"executableBefore",
						"executableAfter",
						"linkBefore",
						"linkAfter"
					]);
					string(row.path, `${subject}.files[${String(index)}].path`);
					literal(row.change, /* @__PURE__ */ new Set([
						"add",
						"retain",
						"replace",
						"remove",
						"restore",
						"purge"
					]), `${subject}.files[${String(index)}].change`);
					if (row.beforeDigest !== null) digest(row.beforeDigest, `${subject}.files[${String(index)}].beforeDigest`);
					if (row.afterDigest !== null) digest(row.afterDigest, `${subject}.files[${String(index)}].afterDigest`);
					integer$1(row.sizeBytes, `${subject}.files[${String(index)}].sizeBytes`);
					bool(row.executableBefore, `${subject}.files[${String(index)}].executableBefore`);
					bool(row.executableAfter, `${subject}.files[${String(index)}].executableAfter`);
					nullableString(row.linkBefore, `${subject}.files[${String(index)}].linkBefore`);
					nullableString(row.linkAfter, `${subject}.files[${String(index)}].linkAfter`);
				});
				const body = exactRecord(input.body, `${subject}.body`, [
					"before",
					"after",
					"beforeDigest",
					"afterDigest"
				]);
				for (const field of ["before", "after"]) if (body[field] !== null && (typeof body[field] !== "string" || body[field].length > 1024 * 1024)) fail(`${subject}.body.${field}`);
				for (const field of ["beforeDigest", "afterDigest"]) if (body[field] !== null) digest(body[field], `${subject}.body.${field}`);
				const invocation = exactRecord(input.invocation, `${subject}.invocation`, [
					"beforeModelInvocable",
					"beforeUserInvocable",
					"afterModelInvocable",
					"afterUserInvocable"
				]);
				for (const field of Object.keys(invocation)) if (invocation[field] !== null) bool(invocation[field], `${subject}.invocation.${field}`);
			} else {
				const descriptor = input.descriptor;
				const transport = literal(descriptor?.transport, /* @__PURE__ */ new Set(["stdio", "http"]), `${subject}.descriptor.transport`);
				const row = exactRecord(input.descriptor, `${subject}.descriptor`, transport === "stdio" ? [
					"transport",
					"serverName",
					"executable",
					"arguments",
					"workingDirectory",
					"toolCallTimeoutMs",
					"reconnect"
				] : [
					"transport",
					"serverName",
					"origin",
					"endpoint",
					"authentication",
					"redirects",
					"dataEgressDisclosure",
					"toolCallTimeoutMs",
					"reconnect"
				]);
				string(row.serverName, `${subject}.descriptor.serverName`);
				if (transport === "stdio") {
					string(row.executable, `${subject}.descriptor.executable`);
					reviewStringArray(row.arguments, `${subject}.descriptor.arguments`, 128);
					if (typeof row.workingDirectory !== "string") fail(`${subject}.descriptor.workingDirectory`);
				} else {
					const origin = string(row.origin, `${subject}.descriptor.origin`, 2048);
					const endpoint = string(row.endpoint, `${subject}.descriptor.endpoint`, 2048);
					if (row.authentication !== "none" || row.redirects !== "forbidden") fail(`${subject}.descriptor.HTTP policy`);
					string(row.dataEgressDisclosure, `${subject}.descriptor.dataEgressDisclosure`, 2048);
					const url = new URL(endpoint);
					if (url.origin !== origin || url.username !== "" || url.password !== "" || url.hash !== "") fail(`${subject}.descriptor.HTTP coordinates`);
				}
				integer$1(row.toolCallTimeoutMs, `${subject}.descriptor.toolCallTimeoutMs`);
				const reconnect = exactRecord(row.reconnect, `${subject}.descriptor.reconnect`, [
					"enabled",
					"initialDelayMs",
					"maxDelayMs",
					"maxAttempts"
				]);
				bool(reconnect.enabled, `${subject}.descriptor.reconnect.enabled`);
				for (const field of [
					"initialDelayMs",
					"maxDelayMs",
					"maxAttempts"
				]) integer$1(reconnect[field], `${subject}.descriptor.reconnect.${field}`);
				const runtime = exactRecord(input.runtime, `${subject}.runtime`, [
					"ownership",
					"version",
					"digest",
					"action"
				]);
				literal(runtime.ownership, /* @__PURE__ */ new Set(["host", "remote"]), `${subject}.runtime.ownership`);
				string(runtime.version, `${subject}.runtime.version`);
				if (runtime.digest !== null) digest(runtime.digest, `${subject}.runtime.digest`);
				if (runtime.action !== "none" || input.credentials !== "none") fail(`${subject}.runtime authority`);
				literal(input.dataEgress, /* @__PURE__ */ new Set(["local-process", "remote-origin"]), `${subject}.dataEgress`);
			}
			return {
				kind,
				operationKind,
				restartRequired
			};
		}
		function sameRuntimeBinding(left, right) {
			return left === null ? right === null : right !== null && left.runtimeRef === right.runtimeRef && left.version === right.version && left.descriptorDigest === right.descriptorDigest;
		}
		function responseSize(value, subject) {
			let serialized;
			try {
				serialized = JSON.stringify(value);
			} catch {
				fail(subject);
			}
			if (new TextEncoder().encode(serialized).byteLength > MAX_RESPONSE_BYTES) fail(subject);
		}
		function canonical(value) {
			if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
			if (typeof value === "number") {
				if (!Number.isFinite(value)) fail("canonical JSON number");
				return JSON.stringify(value);
			}
			if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
			if (typeof value !== "object") fail("canonical JSON value");
			const record = value;
			return `{${Object.keys(record).sort().map((key) => {
				if (record[key] === void 0) fail("canonical JSON field");
				return `${JSON.stringify(key)}:${canonical(record[key])}`;
			}).join(",")}}`;
		}
		async function canonicalDigest(value) {
			if (globalThis.crypto?.subtle === void 0) throw new Error("extension-center: Web Crypto is unavailable; plan integrity cannot be verified");
			const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value)));
			return `sha256:${[...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
		}
		/** Compute the canonical digest shown for one staged configuration payload. */
		function configurationDigest(value) {
			return canonicalDigest(value);
		}
		function capabilities(value, subject) {
			const input = exactRecord(value, subject, [
				"managedPluginLifecycle",
				"dynamicMcpConnection",
				"durableContinuation",
				"skillRegistry",
				"toolRegistry",
				"loaderMutation",
				"acquisition",
				"reason"
			]);
			const managedPluginLifecycle = bool(input.managedPluginLifecycle, `${subject}.managedPluginLifecycle`);
			const dynamicMcpConnection = bool(input.dynamicMcpConnection, `${subject}.dynamicMcpConnection`);
			const durableContinuation = bool(input.durableContinuation, `${subject}.durableContinuation`);
			const skillRegistry = bool(input.skillRegistry, `${subject}.skillRegistry`);
			const toolRegistry = bool(input.toolRegistry, `${subject}.toolRegistry`);
			const loaderMutation = bool(input.loaderMutation, `${subject}.loaderMutation`);
			const acquisition = bool(input.acquisition, `${subject}.acquisition`);
			const reason = input.reason === null ? null : literal(input.reason, /* @__PURE__ */ new Set(["host-capability"]), `${subject}.reason`);
			if (acquisition && !(managedPluginLifecycle && dynamicMcpConnection && durableContinuation && skillRegistry && toolRegistry && loaderMutation) || reason !== (acquisition ? null : "host-capability")) fail(subject);
			return input;
		}
		function action(value, subject) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) fail(subject);
			const status = literal(value.status, /* @__PURE__ */ new Set([
				"available",
				"unavailable",
				"external"
			]), `${subject}.status`);
			const input = exactRecord(value, subject, status === "available" ? ["status"] : ["status", "reason"]);
			if (status !== "available") string(input.reason, `${subject}.reason`, 256);
			return input;
		}
		function evidence(value, kind, subject) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) fail(subject);
			const evidenceKind = literal(value.kind, /* @__PURE__ */ new Set([
				"plugin",
				"mcp",
				"skill"
			]), `${subject}.kind`);
			if (evidenceKind !== kind) fail(`${subject}.kind`);
			if (evidenceKind === "plugin") {
				const input = exactRecord(value, subject, [
					"kind",
					"restartToken",
					"loaderPhase",
					"consumerObserved",
					"restartObserved"
				]);
				nullableString(input.restartToken, `${subject}.restartToken`);
				nullableString(input.loaderPhase, `${subject}.loaderPhase`);
				bool(input.consumerObserved, `${subject}.consumerObserved`);
				bool(input.restartObserved, `${subject}.restartObserved`);
				return input;
			}
			if (evidenceKind === "mcp") {
				const input = exactRecord(value, subject, [
					"kind",
					"descriptorMatches",
					"descriptorDigest",
					"descriptorRevision",
					"transport",
					"desiredEnabled",
					"observedLifecycle",
					"liveDetailAvailable",
					"toolGeneration",
					"qualifiedTools"
				]);
				bool(input.descriptorMatches, `${subject}.descriptorMatches`);
				if (input.descriptorDigest !== null) digest(input.descriptorDigest, `${subject}.descriptorDigest`);
				nullableString(input.descriptorRevision, `${subject}.descriptorRevision`);
				if (input.transport !== null) literal(input.transport, /* @__PURE__ */ new Set(["stdio", "http"]), `${subject}.transport`);
				bool(input.desiredEnabled, `${subject}.desiredEnabled`);
				literal(input.observedLifecycle, /* @__PURE__ */ new Set([
					"absent",
					"disabled",
					"starting",
					"ready",
					"degraded",
					"unknown"
				]), `${subject}.observedLifecycle`);
				bool(input.liveDetailAvailable, `${subject}.liveDetailAvailable`);
				if (input.toolGeneration !== null) integer$1(input.toolGeneration, `${subject}.toolGeneration`);
				array(input.qualifiedTools, `${subject}.qualifiedTools`, 500).forEach((item, index) => {
					string(item, `${subject}.qualifiedTools[${index}]`);
				});
				return input;
			}
			const input = exactRecord(value, subject, [
				"kind",
				"contentRevision",
				"catalogComplete",
				"winningProvider",
				"winningPath",
				"definitionLoaded",
				"invocation"
			]);
			nullableString(input.contentRevision, `${subject}.contentRevision`);
			bool(input.catalogComplete, `${subject}.catalogComplete`);
			nullableString(input.winningProvider, `${subject}.winningProvider`);
			nullableString(input.winningPath, `${subject}.winningPath`);
			bool(input.definitionLoaded, `${subject}.definitionLoaded`);
			if (input.invocation !== null) {
				const invocation = exactRecord(input.invocation, `${subject}.invocation`, ["modelInvocable", "userInvocable"]);
				bool(invocation.modelInvocable, `${subject}.invocation.modelInvocable`);
				bool(invocation.userInvocable, `${subject}.invocation.userInvocable`);
			}
			return input;
		}
		function inventoryRow(value, snapshot, index) {
			const subject = `inventory.rows[${index}]`;
			const input = exactRecord(value, subject, [
				"schemaVersion",
				"kind",
				"extensionId",
				"candidateRef",
				"targetKey",
				"scopeKey",
				"profileId",
				"ownership",
				"desired",
				"materialized",
				"effective",
				"agentVisibility",
				"verification",
				"rollback",
				"managedRevision",
				"ownerRevision",
				"configurationRevision",
				"observedAtMs",
				"actions",
				"updateObservation",
				"restoreObservation",
				"evidence"
			]);
			if (input.schemaVersion !== 1) fail(`${subject}.schemaVersion`);
			const kind = literal(input.kind, /* @__PURE__ */ new Set([
				"plugin",
				"mcp",
				"skill"
			]), `${subject}.kind`);
			string(input.extensionId, `${subject}.extensionId`);
			nullableString(input.candidateRef, `${subject}.candidateRef`);
			string(input.targetKey, `${subject}.targetKey`);
			if (input.scopeKey !== snapshot.scopeKey || input.profileId !== snapshot.profileId) fail(`${subject}.scope`);
			const ownership = literal(input.ownership, /* @__PURE__ */ new Set([
				"center",
				"external",
				"system",
				"parent-plugin"
			]), `${subject}.ownership`);
			literal(input.desired, /* @__PURE__ */ new Set([
				"enabled",
				"disabled",
				"removed"
			]), `${subject}.desired`);
			literal(input.materialized, /* @__PURE__ */ new Set([
				"absent",
				"installed",
				"configured"
			]), `${subject}.materialized`);
			literal(input.effective, /* @__PURE__ */ new Set([
				"inactive",
				"restart-required",
				"starting",
				"active",
				"degraded",
				"activation-failed",
				"unknown"
			]), `${subject}.effective`);
			literal(input.agentVisibility, /* @__PURE__ */ new Set([
				"visible",
				"not-visible",
				"unknown"
			]), `${subject}.agentVisibility`);
			literal(input.verification, /* @__PURE__ */ new Set([
				"unverified",
				"structural",
				"runtime",
				"task"
			]), `${subject}.verification`);
			const rollback = literal(input.rollback, /* @__PURE__ */ new Set([
				"available",
				"running",
				"used",
				"unavailable",
				"failed"
			]), `${subject}.rollback`);
			string(input.managedRevision, `${subject}.managedRevision`);
			string(input.ownerRevision, `${subject}.ownerRevision`);
			nullableString(input.configurationRevision, `${subject}.configurationRevision`);
			if (timestamp(input.observedAtMs, `${subject}.observedAtMs`) > snapshot.observedAtMs) fail(`${subject}.observedAtMs`);
			const actions = exactRecord(input.actions, `${subject}.actions`, [...OPERATIONS]);
			const parsedActions = Object.fromEntries([...OPERATIONS].map((operation) => [operation, action(actions[operation], `${subject}.actions.${operation}`)]));
			if (typeof input.updateObservation !== "object" || input.updateObservation === null || Array.isArray(input.updateObservation)) fail(`${subject}.updateObservation`);
			const updateStatus = literal(input.updateObservation.status, /* @__PURE__ */ new Set([
				"unknown",
				"none",
				"available"
			]), `${subject}.updateObservation.status`);
			const update = exactRecord(input.updateObservation, `${subject}.updateObservation`, updateStatus === "available" ? [
				"status",
				"candidateRef",
				"revision",
				"integrity"
			] : ["status"]);
			if (updateStatus === "available") {
				string(update.candidateRef, `${subject}.updateObservation.candidateRef`);
				string(update.revision, `${subject}.updateObservation.revision`);
				integrity(update.integrity, `${subject}.updateObservation.integrity`);
			}
			if (typeof input.restoreObservation !== "object" || input.restoreObservation === null || Array.isArray(input.restoreObservation)) fail(`${subject}.restoreObservation`);
			const restoreStatus = literal(input.restoreObservation.status, /* @__PURE__ */ new Set([
				"unknown",
				"none",
				"available"
			]), `${subject}.restoreObservation.status`);
			const restore = exactRecord(input.restoreObservation, `${subject}.restoreObservation`, restoreStatus === "available" ? [
				"status",
				"candidateRef",
				"revision",
				"integrity"
			] : ["status"]);
			if (restoreStatus === "available") {
				string(restore.candidateRef, `${subject}.restoreObservation.candidateRef`);
				string(restore.revision, `${subject}.restoreObservation.revision`);
				integrity(restore.integrity, `${subject}.restoreObservation.integrity`);
			}
			if (parsedActions.update.status === "available" && updateStatus !== "available") fail(`${subject}.updateObservation`);
			if (parsedActions.restore.status === "available" && restoreStatus !== "available") fail(`${subject}.restoreObservation`);
			if (restoreStatus === "available" && (ownership !== "center" || !["available", "used"].includes(rollback))) fail(`${subject}.restoreObservation`);
			evidence(input.evidence, kind, `${subject}.evidence`);
			return input;
		}
		/** Strictly validate an inventory/list response and recompute its canonical revision. */
		async function parseInventoryListResponse(value) {
			responseSize(value, "inventory response");
			const input = exactRecord(value, "inventory response", [
				"protocolVersion",
				"hostCapabilities",
				"inventory"
			]);
			if (input.protocolVersion !== PROTOCOL_VERSION) fail("inventory response.protocolVersion");
			capabilities(input.hostCapabilities, "inventory response.hostCapabilities");
			const inventory = exactRecord(input.inventory, "inventory response.inventory", [
				"schemaVersion",
				"scopeKey",
				"profileId",
				"complete",
				"observedAtMs",
				"rows",
				"revision"
			]);
			if (inventory.schemaVersion !== 1) fail("inventory response.inventory.schemaVersion");
			const scopeKey = string(inventory.scopeKey, "inventory response.inventory.scopeKey");
			const profileId = string(inventory.profileId, "inventory response.inventory.profileId");
			bool(inventory.complete, "inventory response.inventory.complete");
			const observedAtMs = timestamp(inventory.observedAtMs, "inventory response.inventory.observedAtMs");
			const revision = digest(inventory.revision, "inventory response.inventory.revision");
			const rows = array(inventory.rows, "inventory response.inventory.rows", MAX_ROWS).map((row, index) => inventoryRow(row, {
				scopeKey,
				profileId,
				observedAtMs
			}, index));
			const identities = /* @__PURE__ */ new Set();
			for (const row of rows) {
				const identity = `${row.kind}\u0000${row.targetKey}`;
				if (identities.has(identity)) fail("inventory response duplicate target");
				identities.add(identity);
			}
			if (await canonicalDigest({
				schemaVersion: 1,
				scopeKey,
				profileId,
				complete: inventory.complete,
				observedAtMs,
				rows
			}) !== revision) throw new Error("extension-center: inventory revision mismatch");
			return input;
		}
		function planContent(value) {
			const subject = "plan.content";
			const input = exactRecord(value, subject, [
				"schemaVersion",
				"singleUse",
				"planId",
				"intentId",
				"origin",
				"candidateRef",
				"extensionKind",
				"extensionId",
				"managedObject",
				"externalRuntimeAction",
				"runtimeBinding",
				"artifactRevision",
				"artifactIntegrity",
				"artifactUrl",
				"artifactSizeBytes",
				"operationKind",
				"desiredState",
				"targetKey",
				"ownerKey",
				"scopeKey",
				"profileId",
				"idempotencyKey",
				"authorityDigest",
				"configurationDigest",
				"retentionDigest",
				"mutationDigest",
				"verificationDigest",
				"reviewEvidence",
				"restartRequired",
				"createdAtMs",
				"expiresAtMs",
				"fences"
			]);
			if (input.schemaVersion !== 1 || input.singleUse !== true) fail(subject);
			string(input.planId, `${subject}.planId`);
			string(input.intentId, `${subject}.intentId`);
			literal(input.origin, /* @__PURE__ */ new Set(["store", "task"]), `${subject}.origin`);
			string(input.candidateRef, `${subject}.candidateRef`);
			literal(input.extensionKind, /* @__PURE__ */ new Set([
				"plugin",
				"mcp",
				"skill"
			]), `${subject}.extensionKind`);
			string(input.extensionId, `${subject}.extensionId`);
			const objectBinding = managedObjectBinding(input, subject);
			if (input.extensionKind === "mcp" !== (objectBinding.managedObject === "connection")) fail(`${subject}.managedObject`);
			string(input.artifactRevision, `${subject}.artifactRevision`);
			integrity(input.artifactIntegrity, `${subject}.artifactIntegrity`);
			const artifactUrl = string(input.artifactUrl, `${subject}.artifactUrl`, 2048);
			try {
				const parsed = new URL(artifactUrl);
				if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") fail(`${subject}.artifactUrl`);
			} catch {
				fail(`${subject}.artifactUrl`);
			}
			integer$1(input.artifactSizeBytes, `${subject}.artifactSizeBytes`);
			literal(input.operationKind, OPERATIONS, `${subject}.operationKind`);
			literal(input.desiredState, /* @__PURE__ */ new Set([
				"enabled",
				"disabled",
				"removed"
			]), `${subject}.desiredState`);
			for (const field of [
				"targetKey",
				"ownerKey",
				"scopeKey",
				"profileId",
				"idempotencyKey"
			]) string(input[field], `${subject}.${field}`);
			for (const field of [
				"authorityDigest",
				"configurationDigest",
				"retentionDigest",
				"mutationDigest",
				"verificationDigest"
			]) digest(input[field], `${subject}.${field}`);
			const review = reviewEvidence(input.reviewEvidence, `${subject}.reviewEvidence`);
			if (review.kind !== input.extensionKind || review.operationKind !== input.operationKind) fail(`${subject}.reviewEvidence binding`);
			const restartRequired = bool(input.restartRequired, `${subject}.restartRequired`);
			if (review.restartRequired !== null && review.restartRequired !== restartRequired) fail(`${subject}.restartRequired binding`);
			if (timestamp(input.createdAtMs, `${subject}.createdAtMs`) >= timestamp(input.expiresAtMs, `${subject}.expiresAtMs`)) fail(`${subject}.expiry`);
			const fences = exactRecord(input.fences, `${subject}.fences`, [
				"catalogRevision",
				"inventoryRevision",
				"targetRevision",
				"ownerRevision",
				"scopeRevision",
				"profileRevision"
			]);
			if (integer$1(fences.catalogRevision, `${subject}.fences.catalogRevision`) < 1) fail(`${subject}.fences.catalogRevision`);
			digest(fences.inventoryRevision, `${subject}.fences.inventoryRevision`);
			for (const field of [
				"targetRevision",
				"ownerRevision",
				"scopeRevision",
				"profileRevision"
			]) string(fences[field], `${subject}.fences.${field}`);
			return input;
		}
		async function plan(value) {
			const input = exactRecord(value, "plan", ["content", "hash"]);
			const content = planContent(input.content);
			const hash = digest(input.hash, "plan.hash");
			if (await canonicalDigest(content) !== hash) throw new Error("extension-center: plan hash mismatch");
			return input;
		}
		function policy(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) fail("intent preview policy");
			const status = literal(value.status, /* @__PURE__ */ new Set(["eligible", "denied"]), "intent preview policy.status");
			const input = exactRecord(value, "intent preview policy", status === "eligible" ? [
				"status",
				"policyRevision",
				"authorityDigest"
			] : [
				"status",
				"policyRevision",
				"code",
				"reason"
			]);
			string(input.policyRevision, "intent preview policy.policyRevision");
			if (status === "eligible") digest(input.authorityDigest, "intent preview policy.authorityDigest");
			else {
				literal(input.code, /* @__PURE__ */ new Set([
					"catalog-unavailable",
					"catalog-incomplete",
					"host-capability",
					"compatibility-unavailable",
					"platform-unavailable",
					"lifecycle-incomplete",
					"action-unavailable",
					"moving-reference",
					"scope-unavailable",
					"authority-unknown",
					"lifecycle-script",
					"credential-unsupported",
					"external-runtime-unresolved",
					"review-evidence-unavailable",
					"verification-incomplete",
					"task-choice-required"
				]), "intent preview policy.code");
				string(input.reason, "intent preview policy.reason", 1e3);
			}
			return input;
		}
		/** Strictly validate an intent/preview response and recompute its plan hash. */
		async function parseIntentPreviewResponse(value) {
			responseSize(value, "intent preview response");
			const input = exactRecord(value, "intent preview response", [
				"protocolVersion",
				"intentId",
				"plan",
				"policy"
			]);
			if (input.protocolVersion !== PROTOCOL_VERSION) fail("intent preview response.protocolVersion");
			const intentId = string(input.intentId, "intent preview response.intentId");
			const verifiedPlan = await plan(input.plan);
			if (verifiedPlan.content.intentId !== intentId || verifiedPlan.content.origin !== "store") fail("intent preview response plan binding");
			const verifiedPolicy = policy(input.policy);
			if (verifiedPolicy.status === "eligible" && verifiedPolicy.authorityDigest !== verifiedPlan.content.authorityDigest) fail("intent preview response authority binding");
			return input;
		}
		async function planState(value) {
			if (typeof value !== "object" || value === null || Array.isArray(value)) fail("plan state");
			const status = literal(value.status, /* @__PURE__ */ new Set([
				"pending",
				"approved",
				"rejected",
				"expired",
				"consumed"
			]), "plan state.status");
			const input = exactRecord(value, "plan state", status === "pending" ? ["status", "plan"] : status === "expired" ? [
				"status",
				"plan",
				"expiredAtMs"
			] : status === "consumed" ? [
				"status",
				"plan",
				"decision",
				"authorization"
			] : [
				"status",
				"plan",
				"decision"
			]);
			const verifiedPlan = await plan(input.plan);
			if (status === "expired") {
				if (timestamp(input.expiredAtMs, "plan state.expiredAtMs") < verifiedPlan.content.expiresAtMs) fail("plan state.expiredAtMs");
			} else if (status !== "pending") {
				const decision = exactRecord(input.decision, "plan state.decision", [
					"planId",
					"planHash",
					"operationKind",
					"decision",
					"decidedAtMs"
				]);
				const decisionValue = literal(decision.decision, /* @__PURE__ */ new Set(["approve", "reject"]), "plan state.decision.decision");
				const decidedAtMs = timestamp(decision.decidedAtMs, "plan state.decision.decidedAtMs");
				if (decision.planId !== verifiedPlan.content.planId || decision.planHash !== verifiedPlan.hash || decision.operationKind !== verifiedPlan.content.operationKind || decidedAtMs < verifiedPlan.content.createdAtMs || decidedAtMs >= verifiedPlan.content.expiresAtMs || status === "approved" && decisionValue !== "approve" || status === "rejected" && decisionValue !== "reject" || status === "consumed" && decisionValue !== "approve") fail("plan state decision binding");
				if (status === "consumed") {
					const authorization = exactRecord(input.authorization, "plan state.authorization", [
						"operationId",
						"planId",
						"planHash",
						"operationKind",
						"managedObject",
						"externalRuntimeAction",
						"runtimeBinding",
						"targetKey",
						"ownerKey",
						"scopeKey",
						"profileId",
						"authorizedAtMs"
					]);
					string(authorization.operationId, "plan state.authorization.operationId");
					const objectBinding = managedObjectBinding(authorization, "plan state.authorization");
					if (authorization.planId !== verifiedPlan.content.planId || authorization.planHash !== verifiedPlan.hash || authorization.operationKind !== verifiedPlan.content.operationKind || objectBinding.managedObject !== verifiedPlan.content.managedObject || objectBinding.externalRuntimeAction !== verifiedPlan.content.externalRuntimeAction || !sameRuntimeBinding(objectBinding.runtimeBinding, verifiedPlan.content.runtimeBinding) || authorization.targetKey !== verifiedPlan.content.targetKey || authorization.ownerKey !== verifiedPlan.content.ownerKey || authorization.scopeKey !== verifiedPlan.content.scopeKey || authorization.profileId !== verifiedPlan.content.profileId) fail("plan state authorization binding");
					const authorizedAtMs = timestamp(authorization.authorizedAtMs, "plan state.authorization.authorizedAtMs");
					if (authorizedAtMs < decidedAtMs || authorizedAtMs >= verifiedPlan.content.expiresAtMs) fail("plan state authorization time binding");
				}
			}
			return input;
		}
		/** Strictly validate task approval rows and their exact typed configuration. */
		async function parseTaskApprovalListResponse(value) {
			responseSize(value, "task approval response");
			const input = exactRecord(value, "task approval response", [
				"protocolVersion",
				"approvals",
				"configurations"
			]);
			if (input.protocolVersion !== PROTOCOL_VERSION) fail("task approval response.protocolVersion");
			const hashes = /* @__PURE__ */ new Set();
			for (const [index, item] of array(input.approvals, "task approval response.approvals", MAX_ROWS).entries()) {
				const subject = `task approval response.approvals[${index}]`;
				const row = exactRecord(item, subject, ["configuration", "state"]);
				const state = await planState(row.state);
				if (state.plan.content.origin !== "task" || !["pending", "approved"].includes(state.status)) fail(`${subject}.state`);
				if (hashes.has(state.plan.hash)) fail("task approval response duplicate plan");
				hashes.add(state.plan.hash);
				rpcJson(row.configuration, `${subject}.configuration`);
			}
			const configurationIds = /* @__PURE__ */ new Set();
			for (const [index, item] of array(input.configurations, "task approval response.configurations", MAX_ROWS).entries()) {
				const subject = `task approval response.configurations[${index}]`;
				const row = exactRecord(item, subject, [
					"candidateRef",
					"continuationId",
					"createdAtMs",
					"expiresAtMs",
					"extensionKind",
					"profileId",
					"resolutionId",
					"scopeKey"
				]);
				const resolutionId = string(row.resolutionId, `${subject}.resolutionId`, 64);
				if (!/^resolution:[0-9a-f-]{36}$/u.test(resolutionId)) fail(`${subject}.resolutionId`);
				const candidateRef = string(row.candidateRef, `${subject}.candidateRef`, 256);
				if (!candidateRef.startsWith("mcp:")) fail(`${subject}.candidateRef`);
				const continuationId = string(row.continuationId, `${subject}.continuationId`, 36);
				if (!/^[0-9a-f-]{36}$/u.test(continuationId)) fail(`${subject}.continuationId`);
				if (row.extensionKind !== "mcp") fail(`${subject}.extensionKind`);
				string(row.scopeKey, `${subject}.scopeKey`, 128);
				string(row.profileId, `${subject}.profileId`, 128);
				if (timestamp(row.createdAtMs, `${subject}.createdAtMs`) >= timestamp(row.expiresAtMs, `${subject}.expiresAtMs`)) fail(`${subject}.expiry`);
				const identity = `${resolutionId}\u0000${candidateRef}`;
				if (configurationIds.has(identity)) fail("task approval response duplicate configuration");
				configurationIds.add(identity);
			}
			return input;
		}
		async function parseTaskConfigurationResponse(value) {
			responseSize(value, "task configuration response");
			const input = exactRecord(value, "task configuration response", [
				"protocolVersion",
				"resolutionId",
				"intentId",
				"plan",
				"policy"
			]);
			if (input.protocolVersion !== PROTOCOL_VERSION) fail("task configuration response.protocolVersion");
			const resolutionId = string(input.resolutionId, "task configuration response.resolutionId", 64);
			if (!/^resolution:[0-9a-f-]{36}$/u.test(resolutionId)) fail("task configuration response.resolutionId");
			const intentId = string(input.intentId, "task configuration response.intentId");
			const verifiedPlan = await plan(input.plan);
			const verifiedPolicy = policy(input.policy);
			if (verifiedPlan.content.origin !== "task" || verifiedPlan.content.intentId !== intentId || verifiedPolicy.status !== "eligible" || verifiedPolicy.authorityDigest !== verifiedPlan.content.authorityDigest) fail("task configuration response plan binding");
			return input;
		}
		function taskAttemptId(value, subject) {
			const result = string(value, subject, 64);
			if (!TASK_ATTEMPT.test(result)) fail(subject);
			return result;
		}
		function candidateRef(value, subject) {
			const result = string(value, subject, 256);
			if (!CANDIDATE.test(result)) fail(subject);
			return result;
		}
		function taskCandidateRefs(value, subject, allowEmpty) {
			const values = array(value, subject, 3).map((item, index) => candidateRef(item, `${subject}[${String(index)}]`));
			if (!allowEmpty && values.length === 0 || new Set(values).size !== values.length || values.some((item, index) => item !== [...values].sort()[index])) fail(subject);
			return values;
		}
		function taskAttempt(value, subject) {
			const input = exactRecord(value, subject, [
				"acquisition",
				"choice",
				"createdAtMs",
				"expiresAtMs",
				"management",
				"originalMessageId",
				"outcome",
				"parentAttemptId",
				"phase",
				"reason",
				"retryContinuation",
				"sessionId",
				"taskAttemptId",
				"trigger",
				"updatedAtMs"
			]);
			const attemptId = taskAttemptId(input.taskAttemptId, `${subject}.taskAttemptId`);
			const parentAttemptId = input.parentAttemptId === null ? null : taskAttemptId(input.parentAttemptId, `${subject}.parentAttemptId`);
			if (parentAttemptId === attemptId) fail(`${subject}.parentAttemptId`);
			const trigger = literal(input.trigger, /* @__PURE__ */ new Set([
				"model",
				"choice-selection",
				"retry-original"
			]), `${subject}.trigger`);
			if (trigger === "model" !== (parentAttemptId === null)) fail(`${subject}.trigger`);
			string(input.sessionId, `${subject}.sessionId`, 512);
			string(input.originalMessageId, `${subject}.originalMessageId`, 512);
			const createdAtMs = timestamp(input.createdAtMs, `${subject}.createdAtMs`);
			const expiresAtMs = timestamp(input.expiresAtMs, `${subject}.expiresAtMs`);
			const updatedAtMs = timestamp(input.updatedAtMs, `${subject}.updatedAtMs`);
			if (createdAtMs >= expiresAtMs || updatedAtMs < createdAtMs) fail(`${subject}.time`);
			const phase = literal(input.phase, /* @__PURE__ */ new Set([
				"checking-existing",
				"resolving",
				"awaiting-approval",
				"acquiring",
				"verifying-visibility",
				"restart-required",
				"ready-to-resume",
				"resuming"
			]), `${subject}.phase`);
			const outcome = input.outcome === null ? null : literal(input.outcome, /* @__PURE__ */ new Set([
				"use-existing",
				"continued",
				"choice-required",
				"management-required",
				"no-eligible-candidate",
				"discovery-unavailable",
				"external-only",
				"rejected",
				"canceled",
				"recovery-required",
				"resume-conflict",
				"failed"
			]), `${subject}.outcome`);
			const reason = input.reason === null ? null : string(input.reason, `${subject}.reason`, 256);
			if (outcome === null !== (reason === null)) fail(`${subject}.reason`);
			let choice = null;
			if (input.choice !== null) choice = { candidateRefs: taskCandidateRefs(exactRecord(input.choice, `${subject}.choice`, ["candidateRefs"]).candidateRefs, `${subject}.choice.candidateRefs`, false) };
			let management = null;
			if (input.management !== null) {
				const row = exactRecord(input.management, `${subject}.management`, ["action", "extensionRef"]);
				const extensionRef = string(row.extensionRef, `${subject}.management.extensionRef`, 64);
				if (!EXTENSION_REF.test(extensionRef)) fail(`${subject}.management.extensionRef`);
				management = {
					extensionRef,
					action: literal(row.action, /* @__PURE__ */ new Set([
						"configure",
						"enable",
						"restore",
						"update"
					]), `${subject}.management.action`)
				};
			}
			let acquisition = null;
			if (input.acquisition !== null) {
				const row = exactRecord(input.acquisition, `${subject}.acquisition`, [
					"candidateRef",
					"continuationId",
					"resolutionId"
				]);
				const resolutionId = string(row.resolutionId, `${subject}.acquisition.resolutionId`, 64);
				const continuationId = string(row.continuationId, `${subject}.acquisition.continuationId`, 36);
				if (!RESOLUTION.test(resolutionId) || !UUID.test(continuationId)) fail(`${subject}.acquisition`);
				acquisition = {
					resolutionId,
					candidateRef: candidateRef(row.candidateRef, `${subject}.acquisition.candidateRef`),
					continuationId
				};
			}
			let retryContinuation = null;
			if (input.retryContinuation !== null) {
				const row = exactRecord(input.retryContinuation, `${subject}.retryContinuation`, ["continuationId", "state"]);
				const continuationId = row.continuationId === null ? null : string(row.continuationId, `${subject}.retryContinuation.continuationId`, 36);
				if (continuationId !== null && !UUID.test(continuationId)) fail(`${subject}.retryContinuation.continuationId`);
				const state = literal(row.state, /* @__PURE__ */ new Set([
					"pending",
					"ready",
					"consumed",
					"dispatching",
					"dispatched",
					"claimed",
					"delivery-unknown",
					"canceled",
					"superseded",
					"expired",
					"invalid",
					"reconciling",
					"unavailable"
				]), `${subject}.retryContinuation.state`);
				if (continuationId === null && ![
					"canceled",
					"reconciling",
					"unavailable"
				].includes(state)) fail(`${subject}.retryContinuation`);
				retryContinuation = {
					continuationId,
					state
				};
			}
			if (outcome === "choice-required" !== (choice !== null) || outcome === "management-required" !== (management !== null) || choice !== null && management !== null || acquisition !== null && (choice !== null || management !== null)) fail(`${subject}.result`);
			if (outcome === null) {
				if (!["checking-existing", "resolving"].includes(phase) !== (acquisition !== null)) fail(`${subject}.acquisition`);
			}
			if ([
				"use-existing",
				"no-eligible-candidate",
				"discovery-unavailable",
				"external-only"
			].includes(String(outcome)) && (choice !== null || management !== null || acquisition !== null)) fail(`${subject}.result`);
			if (retryContinuation !== null && (trigger !== "retry-original" || outcome !== "use-existing")) fail(`${subject}.retryContinuation`);
			return input;
		}
		/** Strictly validate the durable task-attempt activity projection. */
		function parseTaskAttemptListResponse(value) {
			responseSize(value, "task attempt list response");
			const input = exactRecord(value, "task attempt list response", ["attempts", "protocolVersion"]);
			if (input.protocolVersion !== PROTOCOL_VERSION) fail("task attempt list response.protocolVersion");
			const attempts = array(input.attempts, "task attempt list response.attempts", MAX_OPERATIONS).map((item, index) => taskAttempt(item, `task attempt list response.attempts[${String(index)}]`));
			const ids = /* @__PURE__ */ new Set();
			for (const [index, attempt] of attempts.entries()) {
				if (ids.has(attempt.taskAttemptId)) fail("task attempt list response duplicate attempt");
				ids.add(attempt.taskAttemptId);
				if (index > 0) {
					const prior = attempts[index - 1];
					if (prior.createdAtMs > attempt.createdAtMs || prior.createdAtMs === attempt.createdAtMs && prior.taskAttemptId >= attempt.taskAttemptId) fail("task attempt list response ordering");
				}
			}
			if (attempts.some((attempt) => attempt.parentAttemptId !== null && !ids.has(attempt.parentAttemptId))) fail("task attempt list response parent binding");
			return input;
		}
		/** Strictly validate a non-authorizing task choice or Retry-original resolution. */
		function parseTaskAttemptResolutionResponse(value) {
			responseSize(value, "task attempt resolution response");
			const input = exactRecord(value, "task attempt resolution response", [
				"candidateRefs",
				"continuationId",
				"decision",
				"existingCapabilityId",
				"extensionRef",
				"managementAction",
				"needDigest",
				"next",
				"protocolVersion",
				"resolutionId",
				"taskAttemptId"
			]);
			if (input.protocolVersion !== PROTOCOL_VERSION) fail("task attempt resolution response.protocolVersion");
			taskAttemptId(input.taskAttemptId, "task attempt resolution response.taskAttemptId");
			digest(input.needDigest, "task attempt resolution response.needDigest");
			const decision = literal(input.decision, /* @__PURE__ */ new Set([
				"use-existing",
				"management-required",
				"acquisition-candidate",
				"choice-required",
				"no-eligible-candidate",
				"discovery-unavailable"
			]), "task attempt resolution response.decision");
			const candidates = taskCandidateRefs(input.candidateRefs, "task attempt resolution response.candidateRefs", true);
			const resolutionId = input.resolutionId === null ? null : string(input.resolutionId, "task attempt resolution response.resolutionId", 64);
			const continuationId = input.continuationId === null ? null : string(input.continuationId, "task attempt resolution response.continuationId", 36);
			if (resolutionId !== null && !RESOLUTION.test(resolutionId) || continuationId !== null && !UUID.test(continuationId)) fail("task attempt resolution response acquisition ids");
			const existingCapabilityId = input.existingCapabilityId === null ? null : string(input.existingCapabilityId, "task attempt resolution response.existingCapabilityId", 512);
			const extensionRef = input.extensionRef === null ? null : string(input.extensionRef, "task attempt resolution response.extensionRef", 64);
			if (extensionRef !== null && !EXTENSION_REF.test(extensionRef)) fail("task attempt resolution response.extensionRef");
			const managementAction = input.managementAction === null ? null : literal(input.managementAction, /* @__PURE__ */ new Set([
				"configure",
				"enable",
				"restore",
				"update"
			]), "task attempt resolution response.managementAction");
			const next = literal(input.next, /* @__PURE__ */ new Set([
				"use-existing",
				"request-acquisition",
				"human-choice",
				"unavailable"
			]), "task attempt resolution response.next");
			const acquisition = decision === "acquisition-candidate";
			const management = decision === "management-required";
			if (acquisition !== (resolutionId !== null && continuationId !== null && candidates.length === 1) || management !== (extensionRef !== null && managementAction !== null) || decision === "use-existing" !== (existingCapabilityId !== null) || decision === "choice-required" !== (candidates.length > 0 && resolutionId === null) || !acquisition && (resolutionId !== null || continuationId !== null) || !management && (extensionRef !== null || managementAction !== null) || decision !== "use-existing" && existingCapabilityId !== null || decision === "use-existing" && next !== "use-existing" || acquisition && next !== "request-acquisition" && next !== "human-choice" || decision === "choice-required" && next !== "human-choice" || ![
				"use-existing",
				"acquisition-candidate",
				"choice-required"
			].includes(decision) && next !== "unavailable") fail("task attempt resolution response decision binding");
			return input;
		}
		function parseTaskAttemptCancelResponse(value) {
			responseSize(value, "task attempt cancel response");
			const input = exactRecord(value, "task attempt cancel response", ["attempt", "protocolVersion"]);
			if (input.protocolVersion !== PROTOCOL_VERSION) fail("task attempt cancel response.protocolVersion");
			const attempt = taskAttempt(input.attempt, "task attempt cancel response.attempt");
			if (attempt.outcome !== "canceled" && !(attempt.outcome === "use-existing" && attempt.retryContinuation?.state === "canceled")) fail("task attempt cancel response.attempt");
			return input;
		}
		/** Strictly validate safe MCP selectors and current Center-owned configuration. */
		function parseConfigurationOptionsResponse(value) {
			responseSize(value, "configuration options response");
			const input = exactRecord(value, "configuration options response", [
				"protocolVersion",
				"options",
				"currentConfiguration"
			]);
			if (input.protocolVersion !== PROTOCOL_VERSION) fail("configuration options response.protocolVersion");
			const identities = /* @__PURE__ */ new Set();
			for (const [index, item] of array(input.options, "configuration options response.options", 32).entries()) {
				const subject = `configuration options response.options[${index}]`;
				const transport = literal(item?.transport, /* @__PURE__ */ new Set(["stdio", "streamable-http"]), `${subject}.transport`);
				const option = exactRecord(item, subject, transport === "stdio" ? [
					"candidateRef",
					"executablePath",
					"fixedArgs",
					"runtimeRef",
					"transport",
					"version",
					"workingDirectory"
				] : [
					"authentication",
					"candidateRef",
					"dataEgressDisclosure",
					"endpoint",
					"origin",
					"redirects",
					"runtimeRef",
					"transport",
					"version"
				]);
				string(option.candidateRef, `${subject}.candidateRef`, 256);
				const runtimeRef = string(option.runtimeRef, `${subject}.runtimeRef`, 128);
				string(option.version, `${subject}.version`, 128);
				if (transport === "stdio") {
					string(option.executablePath, `${subject}.executablePath`, 4096);
					string(option.workingDirectory, `${subject}.workingDirectory`, 4096);
					for (const [argumentIndex, argument] of array(option.fixedArgs, `${subject}.fixedArgs`, 64).entries()) if (typeof argument !== "string" || argument.length > 4096 || argument.includes("\0")) fail(`${subject}.fixedArgs[${String(argumentIndex)}]`);
				} else {
					if (option.authentication !== "none" || option.redirects !== "forbidden") fail(`${subject}.HTTP policy`);
					const origin = string(option.origin, `${subject}.origin`, 2048);
					const endpoint = string(option.endpoint, `${subject}.endpoint`, 2048);
					string(option.dataEgressDisclosure, `${subject}.dataEgressDisclosure`, 2048);
					let parsedOrigin;
					let parsedEndpoint;
					try {
						parsedOrigin = new URL(origin);
						parsedEndpoint = new URL(endpoint);
					} catch {
						fail(`${subject}.HTTP coordinates`);
					}
					if (parsedOrigin.protocol !== "https:" || parsedEndpoint.protocol !== "https:" || parsedOrigin.username !== "" || parsedOrigin.password !== "" || parsedEndpoint.username !== "" || parsedEndpoint.password !== "" || parsedOrigin.pathname !== "/" || parsedOrigin.search !== "" || parsedOrigin.hash !== "" || parsedEndpoint.hash !== "" || parsedOrigin.origin !== origin || parsedEndpoint.toString() !== endpoint || parsedEndpoint.origin !== origin) fail(`${subject}.HTTP coordinates`);
				}
				if (identities.has(runtimeRef)) fail("configuration options response duplicate runtimeRef");
				identities.add(runtimeRef);
			}
			if (input.currentConfiguration !== null) rpcJson(input.currentConfiguration, "configuration options response.currentConfiguration");
			return input;
		}
		function receiptBody(value, subject) {
			const input = exactRecord(value, subject, [
				"schemaVersion",
				"operationId",
				"planId",
				"planHash",
				"operationKind",
				"managedObject",
				"externalRuntimeAction",
				"runtimeBinding",
				"planEvidence",
				"targetKey",
				"outcome",
				"beforeDigest",
				"afterDigest",
				"mutationDigests",
				"verificationDigests",
				"evidence",
				"journalEventCount",
				"journalHeadDigest",
				"issuedAtMs"
			]);
			if (input.schemaVersion !== 1) fail(`${subject}.schemaVersion`);
			for (const field of [
				"operationId",
				"planId",
				"targetKey"
			]) string(input[field], `${subject}.${field}`);
			digest(input.planHash, `${subject}.planHash`);
			literal(input.operationKind, OPERATIONS, `${subject}.operationKind`);
			managedObjectBinding(input, subject);
			const planEvidence = receiptPlanEvidence(input.planEvidence, `${subject}.planEvidence`);
			const outcome = literal(input.outcome, /* @__PURE__ */ new Set([
				"committed",
				"rolled-back",
				"failed"
			]), `${subject}.outcome`);
			digest(input.beforeDigest, `${subject}.beforeDigest`);
			if (input.afterDigest !== null) digest(input.afterDigest, `${subject}.afterDigest`);
			for (const field of ["mutationDigests", "verificationDigests"]) array(input[field], `${subject}.${field}`, 2e3).forEach((item, index) => {
				digest(item, `${subject}.${field}[${index}]`);
			});
			receiptEvidence(input.evidence, {
				outcome,
				mutationCount: input.mutationDigests.length,
				verificationCount: input.verificationDigests.length,
				restartRequired: planEvidence.restartRequired
			}, `${subject}.evidence`);
			if (integer$1(input.journalEventCount, `${subject}.journalEventCount`) < 1) fail(`${subject}.journalEventCount`);
			digest(input.journalHeadDigest, `${subject}.journalHeadDigest`);
			timestamp(input.issuedAtMs, `${subject}.issuedAtMs`);
			return input;
		}
		function receiptPlanEvidence(value, subject) {
			const input = exactRecord(value, subject, [
				"origin",
				"candidateRef",
				"extensionKind",
				"extensionId",
				"artifactRevision",
				"artifactIntegrity",
				"artifactUrl",
				"artifactSizeBytes",
				"desiredState",
				"ownerKey",
				"scopeKey",
				"profileId",
				"idempotencyKey",
				"authorityDigest",
				"configurationDigest",
				"retentionDigest",
				"mutationDigest",
				"verificationDigest",
				"reviewEvidence",
				"restartRequired",
				"fences",
				"recoveryExecutable"
			]);
			literal(input.origin, /* @__PURE__ */ new Set(["store", "task"]), `${subject}.origin`);
			for (const field of [
				"candidateRef",
				"extensionId",
				"artifactRevision",
				"ownerKey",
				"scopeKey",
				"profileId",
				"idempotencyKey"
			]) string(input[field], `${subject}.${field}`);
			literal(input.extensionKind, /* @__PURE__ */ new Set([
				"plugin",
				"mcp",
				"skill"
			]), `${subject}.extensionKind`);
			integrity(input.artifactIntegrity, `${subject}.artifactIntegrity`);
			const artifactUrl = string(input.artifactUrl, `${subject}.artifactUrl`, 2048);
			try {
				const parsed = new URL(artifactUrl);
				if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") fail(`${subject}.artifactUrl`);
			} catch {
				fail(`${subject}.artifactUrl`);
			}
			integer$1(input.artifactSizeBytes, `${subject}.artifactSizeBytes`);
			literal(input.desiredState, /* @__PURE__ */ new Set([
				"enabled",
				"disabled",
				"removed"
			]), `${subject}.desiredState`);
			for (const field of [
				"authorityDigest",
				"configurationDigest",
				"retentionDigest",
				"mutationDigest",
				"verificationDigest"
			]) digest(input[field], `${subject}.${field}`);
			const review = reviewEvidence(input.reviewEvidence, `${subject}.reviewEvidence`);
			if (review.kind !== input.extensionKind) fail(`${subject}.reviewEvidence binding`);
			const restartRequired = bool(input.restartRequired, `${subject}.restartRequired`);
			if (review.restartRequired !== null && review.restartRequired !== restartRequired) fail(`${subject}.restartRequired binding`);
			const fences = exactRecord(input.fences, `${subject}.fences`, [
				"catalogRevision",
				"inventoryRevision",
				"targetRevision",
				"ownerRevision",
				"scopeRevision",
				"profileRevision"
			]);
			if (integer$1(fences.catalogRevision, `${subject}.fences.catalogRevision`) < 1) fail(`${subject}.fences.catalogRevision`);
			digest(fences.inventoryRevision, `${subject}.fences.inventoryRevision`);
			for (const field of [
				"targetRevision",
				"ownerRevision",
				"scopeRevision",
				"profileRevision"
			]) string(fences[field], `${subject}.fences.${field}`);
			const recovery = exactRecord(input.recoveryExecutable, `${subject}.recoveryExecutable`, [
				"arch",
				"centerRoot",
				"executablePath",
				"executableSha256",
				"officialDsh",
				"packageVersion",
				"platform",
				"schemaVersion"
			]);
			if (recovery.schemaVersion !== 5) fail(`${subject}.recoveryExecutable.schemaVersion`);
			literal(recovery.platform, /* @__PURE__ */ new Set([
				"darwin",
				"linux",
				"win32"
			]), `${subject}.recoveryExecutable.platform`);
			for (const field of ["executablePath", "centerRoot"]) absolutePath$1(recovery[field], `${subject}.recoveryExecutable.${field}`);
			digest(recovery.executableSha256, `${subject}.recoveryExecutable.executableSha256`);
			string(recovery.packageVersion, `${subject}.recoveryExecutable.packageVersion`, 128);
			if (!/^[a-z0-9][a-z0-9._-]*$/u.test(string(recovery.arch, `${subject}.recoveryExecutable.arch`, 64))) fail(`${subject}.recoveryExecutable.arch`);
			const officialDsh = exactRecord(recovery.officialDsh, `${subject}.recoveryExecutable.officialDsh`, [
				"entrypointPath",
				"entrypointSha256",
				"hostHome",
				"packageName",
				"packageRoot",
				"packageTreeSha256",
				"packageVersion",
				"pnpm",
				"productionDependencies",
				"schemaVersion",
				"supervisorPath",
				"supervisorSha256",
				"timeoutMs",
				"node"
			]);
			if (officialDsh.schemaVersion !== 2 || officialDsh.packageName !== "@deepseek-ai/dsh" || officialDsh.packageVersion !== "0.1.2-alpha.1") fail(`${subject}.recoveryExecutable.officialDsh identity`);
			for (const field of [
				"entrypointPath",
				"hostHome",
				"packageRoot",
				"supervisorPath"
			]) absolutePath$1(officialDsh[field], `${subject}.recoveryExecutable.officialDsh.${field}`);
			digest(officialDsh.entrypointSha256, `${subject}.recoveryExecutable.officialDsh.entrypointSha256`);
			digest(officialDsh.packageTreeSha256, `${subject}.recoveryExecutable.officialDsh.packageTreeSha256`);
			digest(officialDsh.supervisorSha256, `${subject}.recoveryExecutable.officialDsh.supervisorSha256`);
			const recoveryTimeout = integer$1(officialDsh.timeoutMs, `${subject}.recoveryExecutable.officialDsh.timeoutMs`);
			if (recoveryTimeout < 1e3 || recoveryTimeout > 6e5) fail(`${subject}.recoveryExecutable.officialDsh.timeoutMs`);
			let previousDependency = "";
			array(officialDsh.productionDependencies, `${subject}.recoveryExecutable.officialDsh.productionDependencies`, 1024).forEach((value, index) => {
				const dependencySubject = `${subject}.recoveryExecutable.officialDsh.productionDependencies[${String(index)}]`;
				const dependency = exactRecord(value, dependencySubject, [
					"packageName",
					"packageRoot",
					"packageTreeSha256",
					"packageVersion"
				]);
				const packageName = string(dependency.packageName, `${dependencySubject}.packageName`, 256);
				const packageVersion = string(dependency.packageVersion, `${dependencySubject}.packageVersion`, 128);
				const packageRoot = absolutePath$1(dependency.packageRoot, `${dependencySubject}.packageRoot`);
				digest(dependency.packageTreeSha256, `${dependencySubject}.packageTreeSha256`);
				const key = `${packageName}\0${packageVersion}\0${packageRoot}`;
				if (index > 0 && previousDependency.localeCompare(key) >= 0) fail(`${subject}.recoveryExecutable.officialDsh.productionDependencies`);
				previousDependency = key;
			});
			const node = exactRecord(officialDsh.node, `${subject}.recoveryExecutable.officialDsh.node`, [
				"executablePath",
				"executableSha256",
				"schemaVersion",
				"version"
			]);
			if (node.schemaVersion !== 1) fail(`${subject}.recoveryExecutable.officialDsh.node.schemaVersion`);
			absolutePath$1(node.executablePath, `${subject}.recoveryExecutable.officialDsh.node.executablePath`);
			digest(node.executableSha256, `${subject}.recoveryExecutable.officialDsh.node.executableSha256`);
			if (!/^v\d+\.\d+\.\d+(?:[-+].*)?$/u.test(string(node.version, `${subject}.recoveryExecutable.officialDsh.node.version`, 64))) fail(`${subject}.recoveryExecutable.officialDsh.node.version`);
			const pnpm = exactRecord(officialDsh.pnpm, `${subject}.recoveryExecutable.officialDsh.pnpm`, [
				"entrypointPath",
				"entrypointSha256",
				"packageName",
				"packageRoot",
				"packageTreeSha256",
				"packageVersion",
				"registryIntegrity",
				"runtimeRoot",
				"schemaVersion",
				"shellPath",
				"shellSha256",
				"shimPath",
				"shimSha256"
			]);
			if (pnpm.schemaVersion !== 1 || pnpm.packageName !== "pnpm" || !isReadablePnpmExecutionIdentity({
				packageVersion: pnpm.packageVersion,
				registryIntegrity: pnpm.registryIntegrity
			})) fail(`${subject}.recoveryExecutable.officialDsh.pnpm identity`);
			for (const field of [
				"packageRoot",
				"entrypointPath",
				"shimPath",
				"shellPath",
				"runtimeRoot"
			]) absolutePath$1(pnpm[field], `${subject}.recoveryExecutable.officialDsh.pnpm.${field}`);
			for (const field of [
				"packageTreeSha256",
				"entrypointSha256",
				"shimSha256",
				"shellSha256"
			]) digest(pnpm[field], `${subject}.recoveryExecutable.officialDsh.pnpm.${field}`);
			return input;
		}
		function receiptEvidence(value, context, subject) {
			const input = exactRecord(value, subject, [
				"checksActuallyRun",
				"mutation",
				"verification",
				"rollback",
				"restart",
				"recovery",
				"notProven"
			]);
			array(input.checksActuallyRun, `${subject}.checksActuallyRun`, 64).forEach((item, index) => {
				const row = exactRecord(item, `${subject}.checksActuallyRun[${String(index)}]`, ["code", "phase"]);
				string(row.code, `${subject}.checksActuallyRun[${String(index)}].code`, 128);
				literal(row.phase, /* @__PURE__ */ new Set([
					"planning",
					"prepare",
					"apply",
					"verify",
					"external-restart"
				]), `${subject}.checksActuallyRun[${String(index)}].phase`);
			});
			const statuses = /* @__PURE__ */ new Set([
				"proven",
				"not-required",
				"not-proven"
			]);
			const mutation = literal(input.mutation, statuses, `${subject}.mutation`);
			const verification = literal(input.verification, statuses, `${subject}.verification`);
			const rollback = exactRecord(input.rollback, `${subject}.rollback`, ["attempted", "status"]);
			const rollbackAttempted = bool(rollback.attempted, `${subject}.rollback.attempted`);
			const rollbackStatus = literal(rollback.status, statuses, `${subject}.rollback.status`);
			const restart = exactRecord(input.restart, `${subject}.restart`, ["required", "status"]);
			const restartRequired = bool(restart.required, `${subject}.restart.required`);
			const restartStatus = literal(restart.status, statuses, `${subject}.restart.status`);
			const recovery = exactRecord(input.recovery, `${subject}.recovery`, ["attempts", "status"]);
			const recoveryAttempts = integer$1(recovery.attempts, `${subject}.recovery.attempts`);
			const recoveryStatus = literal(recovery.status, statuses, `${subject}.recovery.status`);
			const expected = {
				mutation: context.mutationCount > 0 ? "proven" : context.outcome === "failed" ? "not-required" : "not-proven",
				verification: context.outcome === "committed" && context.verificationCount > 0 ? "proven" : context.outcome === "failed" ? "not-required" : "not-proven",
				rollback: rollbackAttempted ? context.outcome === "rolled-back" ? "proven" : "not-proven" : "not-required",
				restart: context.restartRequired && context.mutationCount > 0 ? context.verificationCount > 0 && context.outcome !== "failed" ? "proven" : "not-proven" : "not-required",
				recovery: recoveryAttempts === 0 ? "not-required" : context.outcome === "rolled-back" ? "proven" : "not-proven"
			};
			if (mutation !== expected.mutation || verification !== expected.verification || rollbackStatus !== expected.rollback || restartRequired !== (context.restartRequired && context.mutationCount > 0) || restartStatus !== expected.restart || recoveryStatus !== expected.recovery) fail(subject);
			const claimOrder = [
				"mutation",
				"verification",
				"rollback",
				"restart",
				"recovery"
			];
			const notProven = array(input.notProven, `${subject}.notProven`, claimOrder.length).map((claim, index) => literal(claim, new Set(claimOrder), `${subject}.notProven[${String(index)}]`));
			const expectedClaims = claimOrder.filter((claim) => expected[claim] === "not-proven");
			if (notProven.length !== expectedClaims.length || notProven.some((claim, index) => claim !== expectedClaims[index])) fail(`${subject}.notProven`);
		}
		async function receipt(value, subject) {
			const input = exactRecord(value, subject, ["body", "digest"]);
			const body = receiptBody(input.body, `${subject}.body`);
			const receiptDigest = digest(input.digest, `${subject}.digest`);
			if (await canonicalDigest(body) !== receiptDigest) throw new Error(`extension-center: ${subject} digest mismatch`);
			return input;
		}
		async function parseLifecycleResponse(value) {
			responseSize(value, "lifecycle response");
			const input = exactRecord(value, "lifecycle response", [
				"protocolVersion",
				"operationId",
				"status",
				"receipt"
			]);
			if (input.protocolVersion !== PROTOCOL_VERSION) fail("lifecycle response.protocolVersion");
			const operationId = string(input.operationId, "lifecycle response.operationId");
			const status = literal(input.status, /* @__PURE__ */ new Set([
				"committed",
				"rolled-back",
				"failed",
				"recovery-required",
				"restart-required"
			]), "lifecycle response.status");
			if (status === "restart-required" || status === "recovery-required") {
				if (input.receipt !== null) fail("lifecycle response.receipt");
			} else {
				const verified = await receipt(input.receipt, "lifecycle response.receipt");
				if (verified.body.operationId !== operationId || verified.body.outcome !== status) fail("lifecycle response receipt binding");
			}
			return input;
		}
		/** Strictly validate an operation/list response. */
		function parseOperationListResponse(value) {
			responseSize(value, "operation list response");
			const input = exactRecord(value, "operation list response", ["protocolVersion", "operations"]);
			if (input.protocolVersion !== PROTOCOL_VERSION) fail("operation list response.protocolVersion");
			const identities = /* @__PURE__ */ new Set();
			array(input.operations, "operation list response.operations", MAX_OPERATIONS).forEach((value, index) => {
				const subject = `operation list response.operations[${index}]`;
				const row = exactRecord(value, subject, [
					"operationId",
					"targetKey",
					"phase",
					"operationKind",
					"lastAtMs",
					"recoveryCommand",
					"recoveryNotice"
				]);
				const operationId = string(row.operationId, `${subject}.operationId`);
				if (identities.has(operationId)) fail("operation list response duplicate operation");
				identities.add(operationId);
				string(row.targetKey, `${subject}.targetKey`);
				const phase = literal(row.phase, /* @__PURE__ */ new Set([
					"authorized",
					"staging",
					"applying",
					"verifying",
					"rolling-back",
					"committed",
					"rolled-back",
					"failed",
					"recovery-required"
				]), `${subject}.phase`);
				literal(row.operationKind, OPERATIONS, `${subject}.operationKind`);
				timestamp(row.lastAtMs, `${subject}.lastAtMs`);
				if (row.recoveryNotice === "retired-runtime-quarantined") {
					if (row.recoveryCommand !== null || phase === "committed") fail(`${subject}.recovery fields`);
				} else if (phase === "recovery-required") if (row.recoveryCommand === null) {
					if (row.recoveryNotice !== null) fail(`${subject}.recoveryNotice`);
				} else {
					const command = array(row.recoveryCommand, `${subject}.recoveryCommand`, 3);
					if (command.length !== 3) fail(`${subject}.recoveryCommand`);
					command.forEach((argument, argumentIndex) => {
						string(argument, `${subject}.recoveryCommand[${String(argumentIndex)}]`, 4096);
					});
					if (row.recoveryNotice !== "journal-reconciliation-pending") fail(`${subject}.recoveryNotice`);
				}
				else if (row.recoveryCommand !== null || row.recoveryNotice !== null) fail(`${subject}.recovery fields`);
			});
			return input;
		}
		/** Strictly validate an operation/receipts response and every receipt digest. */
		async function parseOperationReceiptsResponse(value) {
			responseSize(value, "operation receipts response");
			const input = exactRecord(value, "operation receipts response", ["protocolVersion", "receipts"]);
			if (input.protocolVersion !== PROTOCOL_VERSION) fail("operation receipts response.protocolVersion");
			const identities = /* @__PURE__ */ new Set();
			for (const [index, value] of array(input.receipts, "operation receipts response.receipts", MAX_OPERATIONS).entries()) {
				const subject = `operation receipts response.receipts[${index}]`;
				const stored = exactRecord(value, subject, [
					"operationId",
					"targetKey",
					"receipt"
				]);
				const operationId = string(stored.operationId, `${subject}.operationId`);
				const targetKey = string(stored.targetKey, `${subject}.targetKey`);
				if (identities.has(operationId)) fail("operation receipts response duplicate operation");
				identities.add(operationId);
				const verified = await receipt(stored.receipt, `${subject}.receipt`);
				if (verified.body.operationId !== operationId || verified.body.targetKey !== targetKey) fail(`${subject} binding`);
			}
			return input;
		}
		async function call(rpc, endpoint, payload, signal) {
			const result = await rpc.call(EXTENSION_CENTER_RPC_CHANNEL, endpoint, payload, signal);
			if (!result.ok) throw new ExtensionCenterRpcError(result.error);
			return result.value;
		}
		/** Create a stateless, strict management client over the Connection carrier. */
		function createExtensionManagementClient(rpc) {
			return {
				async inventory(scopeKey, profileId, signal) {
					const response = await parseInventoryListResponse(await call(rpc, "inventory/list", {
						protocolVersion: PROTOCOL_VERSION,
						scopeKey,
						profileId
					}, signal));
					if (response.inventory.scopeKey !== scopeKey || response.inventory.profileId !== profileId) fail("inventory response request binding");
					return response;
				},
				async verify(scopeKey, profileId, targetKey, signal) {
					string(targetKey, "inventory verify request.targetKey");
					const response = await parseInventoryListResponse(await call(rpc, "inventory/verify", {
						protocolVersion: PROTOCOL_VERSION,
						scopeKey,
						profileId,
						targetKey
					}, signal));
					if (response.inventory.scopeKey !== scopeKey || response.inventory.profileId !== profileId || !response.inventory.rows.some((row) => row.targetKey === targetKey)) fail("inventory verify response request binding");
					return response;
				},
				async preview(input, signal) {
					if (input.targetKey !== null) string(input.targetKey, "intent preview request.targetKey");
					if (input.targetKey === null && (input.operationKind === "enable" || input.operationKind === "disable" || input.operationKind === "purge")) fail("intent preview request.targetKey");
					const response = await parseIntentPreviewResponse(await call(rpc, "intent/preview", {
						protocolVersion: PROTOCOL_VERSION,
						origin: "store",
						candidateRef: input.candidateRef,
						operationKind: input.operationKind,
						scopeKey: input.scopeKey,
						profileId: input.profileId,
						targetKey: input.targetKey,
						continuationId: null,
						configuration: input.configuration
					}, signal));
					if (response.plan.content.candidateRef !== input.candidateRef || response.plan.content.operationKind !== input.operationKind || response.plan.content.scopeKey !== input.scopeKey || response.plan.content.profileId !== input.profileId || input.targetKey !== null && response.plan.content.targetKey !== input.targetKey) fail("intent preview response request binding");
					return response;
				},
				async configurationOptions(input, signal) {
					if (input.targetKey !== null) string(input.targetKey, "configuration options request.targetKey");
					literal(input.operationKind, new Set(OPERATIONS), "configuration options request.operationKind");
					const response = parseConfigurationOptionsResponse(await call(rpc, "configuration/options", {
						protocolVersion: PROTOCOL_VERSION,
						candidateRef: input.candidateRef,
						operationKind: input.operationKind,
						targetKey: input.targetKey,
						scopeKey: input.scopeKey,
						profileId: input.profileId
					}, signal));
					if (response.options.some((option) => option.candidateRef !== input.candidateRef)) fail("configuration options response request binding");
					return response;
				},
				async taskApprovals(signal) {
					return parseTaskApprovalListResponse(await call(rpc, "approval/list", { protocolVersion: PROTOCOL_VERSION }, signal));
				},
				async configureTask(input, signal) {
					if (!/^resolution:[0-9a-f-]{36}$/u.test(input.resolutionId) || !input.candidateRef.startsWith("mcp:") || !/^[0-9a-f-]{36}$/u.test(input.continuationId)) fail("task configuration request binding");
					rpcJson(input.configuration, "task configuration request.configuration");
					const response = await parseTaskConfigurationResponse(await call(rpc, "approval/configure", {
						protocolVersion: PROTOCOL_VERSION,
						resolutionId: input.resolutionId,
						candidateRef: input.candidateRef,
						continuationId: input.continuationId,
						configuration: input.configuration
					}, signal));
					if (response.resolutionId !== input.resolutionId || response.plan.content.candidateRef !== input.candidateRef) fail("task configuration response request binding");
					return response;
				},
				async taskAttempts(signal) {
					return parseTaskAttemptListResponse(await call(rpc, "task-attempt/list", { protocolVersion: PROTOCOL_VERSION }, signal));
				},
				async selectTaskCandidate(sourceTaskAttemptId, selectedCandidateRef, signal) {
					taskAttemptId(sourceTaskAttemptId, "task choice request.taskAttemptId");
					candidateRef(selectedCandidateRef, "task choice request.candidateRef");
					const response = parseTaskAttemptResolutionResponse(await call(rpc, "task-attempt/select", {
						protocolVersion: PROTOCOL_VERSION,
						taskAttemptId: sourceTaskAttemptId,
						candidateRef: selectedCandidateRef
					}, signal));
					if (response.taskAttemptId === sourceTaskAttemptId || response.decision === "acquisition-candidate" && response.candidateRefs[0] !== selectedCandidateRef) fail("task choice response request binding");
					return response;
				},
				async retryOriginalTask(sourceTaskAttemptId, signal) {
					taskAttemptId(sourceTaskAttemptId, "task retry request.taskAttemptId");
					const response = parseTaskAttemptResolutionResponse(await call(rpc, "task-attempt/retry", {
						protocolVersion: PROTOCOL_VERSION,
						taskAttemptId: sourceTaskAttemptId
					}, signal));
					if (response.taskAttemptId === sourceTaskAttemptId) fail("task retry response request binding");
					return response;
				},
				async cancelTaskAttempt(requestedTaskAttemptId, signal) {
					taskAttemptId(requestedTaskAttemptId, "task cancel request.taskAttemptId");
					const response = parseTaskAttemptCancelResponse(await call(rpc, "task-attempt/cancel", {
						protocolVersion: PROTOCOL_VERSION,
						taskAttemptId: requestedTaskAttemptId
					}, signal));
					if (response.attempt.taskAttemptId !== requestedTaskAttemptId) fail("task cancel response request binding");
					return response;
				},
				async plan(planHash, signal) {
					digest(planHash, "plan get request.planHash");
					const input = exactRecord(await call(rpc, "plan/get", {
						protocolVersion: PROTOCOL_VERSION,
						planHash
					}, signal), "plan get response", ["protocolVersion", "state"]);
					if (input.protocolVersion !== PROTOCOL_VERSION) fail("plan get response.protocolVersion");
					if (input.state === null) return null;
					const state = await planState(input.state);
					if (state.plan.hash !== planHash) fail("plan get response request binding");
					return state;
				},
				async decide(planValue, decision, signal) {
					const input = exactRecord(await call(rpc, "plan/decide", {
						protocolVersion: PROTOCOL_VERSION,
						planId: planValue.content.planId,
						planHash: planValue.hash,
						operationKind: planValue.content.operationKind,
						decision
					}, signal), "plan decision response", ["protocolVersion", "state"]);
					if (input.protocolVersion !== PROTOCOL_VERSION) fail("plan decision response.protocolVersion");
					const state = await planState(input.state);
					if (state.plan.hash !== planValue.hash) fail("plan decision response request binding");
					return state;
				},
				async execute(planHash, signal) {
					digest(planHash, "lifecycle request.planHash");
					const response = await parseLifecycleResponse(await call(rpc, "lifecycle/request", {
						protocolVersion: PROTOCOL_VERSION,
						planHash
					}, signal));
					if (response.receipt !== null && response.receipt.body.planHash !== planHash) fail("lifecycle response request binding");
					return response;
				},
				async recover(operationId, signal) {
					string(operationId, "operation recovery request.operationId");
					const response = await parseLifecycleResponse(await call(rpc, "operation/recover", {
						protocolVersion: PROTOCOL_VERSION,
						operationId
					}, signal));
					if (response.operationId !== operationId) fail("operation recovery response request binding");
					return response;
				},
				async operations(signal) {
					return parseOperationListResponse(await call(rpc, "operation/list", { protocolVersion: PROTOCOL_VERSION }, signal));
				},
				async receipts(signal) {
					return parseOperationReceiptsResponse(await call(rpc, "operation/receipts", { protocolVersion: PROTOCOL_VERSION }, signal));
				}
			};
		}
		/** Parse one JSON configuration draft into the strict RPC JSON subset. */
		function parseConfigurationDraft(text) {
			let value;
			try {
				value = JSON.parse(text);
			} catch {
				throw new Error("invalid-json");
			}
			const visit = (item) => {
				if (item === null || typeof item === "string" || typeof item === "boolean") return item;
				if (typeof item === "number" && Number.isFinite(item)) return item;
				if (Array.isArray(item)) return item.map(visit);
				if (typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, child]) => {
					if (child === void 0) throw new Error("invalid-json");
					return [key, visit(child)];
				}));
				throw new Error("invalid-json");
			};
			return visit(value);
		}
		//#endregion
		//#region lib/.build/client/PlanReview.js
		function localize$1(value, language) {
			return value[language];
		}
		function configurationDiff(value) {
			if (typeof value === "object" && value !== null && !Array.isArray(value)) return Object.entries(value).map(([key, child]) => `+ ${key}: ${JSON.stringify(child)}`).join("\n");
			return `+ value: ${JSON.stringify(value)}`;
		}
		/** Ordinary-user projection of the exact kind-specific facts protected by the plan hash. */
		function ReviewEvidenceDetails({ evidence, t }) {
			const exact = evidence.kind === "plugin" ? {
				manifest: evidence.manifest,
				dependencies: evidence.dependencies,
				managedMaterial: evidence.managedMaterial,
				packageMetadata: evidence.packageMetadata,
				activation: evidence.activation,
				scripts: evidence.scripts,
				settings: evidence.settings
			} : evidence.kind === "skill" ? {
				files: evidence.files,
				invocation: evidence.invocation,
				before: evidence.body.before,
				after: evidence.body.after
			} : {
				descriptor: evidence.descriptor,
				runtime: evidence.runtime,
				credentials: evidence.credentials,
				dataEgress: evidence.dataEgress
			};
			return (0, react_jsx_runtime.jsxs)("section", {
				className: ExtensionCenter_module_css_default.configurationDiff,
				"aria-label": t("review.heading"),
				children: [
					(0, react_jsx_runtime.jsx)("h4", { children: t("review.heading") }),
					(0, react_jsx_runtime.jsx)("p", { children: t("review.body") }),
					(0, react_jsx_runtime.jsxs)("dl", {
						className: ExtensionCenter_module_css_default.planFacts,
						children: [
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("review.checks") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: evidence.checks.map((item) => `${item.phase}:${item.code}`).join(", ") }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("review.removed") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: evidence.removed.length === 0 ? t("field.none") : evidence.removed.map((item) => `${item.kind}:${item.id}`).join(", ") }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("review.retained") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: evidence.retained.length === 0 ? t("field.none") : evidence.retained.map((item) => `${item.kind}:${item.id}`).join(", ") }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("review.credentials") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: evidence.credentialChoice }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("review.rollback") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: evidence.rollbackPoint === null ? t("field.none") : `${evidence.rollbackPoint.kind}:${evidence.rollbackPoint.id} @ ${evidence.rollbackPoint.digest}` }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("review.limits") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: evidence.rollbackLimits.join(", ") || t("field.none") }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("review.notProven") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: evidence.notProven.join(", ") || t("field.none") }) })] })
						]
					}),
					(0, react_jsx_runtime.jsx)("h4", { children: t(`review.${evidence.kind}`) }),
					(0, react_jsx_runtime.jsx)("pre", { children: JSON.stringify(exact, null, 2) })
				]
			});
		}
		/** Render the immutable plan and keep decision separate from lifecycle execution. */
		function PlanReview({ preview, candidate, management, configuration, initialState, t, onClose, onCommitted }) {
			const [busy, setBusy] = (0, react.useState)();
			const [decisionLocked, setDecisionLocked] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)();
			const [planStatus, setPlanStatus] = (0, react.useState)(initialState?.status ?? "pending");
			const [result, setResult] = (0, react.useState)();
			const [configDigest, setConfigDigest] = (0, react.useState)();
			const [expired, setExpired] = (0, react.useState)(() => Date.now() >= preview.plan.content.expiresAtMs);
			const surface = (0, react.useRef)(null);
			const request = (0, react.useRef)();
			const decisionClaimed = (0, react.useRef)(false);
			const language = t("locale.code") === "zh" ? "zh" : "en";
			const { plan, policy } = preview;
			(0, react.useEffect)(() => {
				surface.current?.focus();
				return () => {
					request.current?.abort();
				};
			}, []);
			(0, react.useEffect)(() => {
				if (configuration === void 0) {
					setConfigDigest(void 0);
					return;
				}
				let active = true;
				configurationDigest(configuration).then((value) => {
					if (active) setConfigDigest(value);
				}).catch(() => {
					if (active) setConfigDigest(t("plan.digestUnavailable"));
				});
				return () => {
					active = false;
				};
			}, [configuration, t]);
			(0, react.useEffect)(() => {
				let timer;
				const check = () => {
					const remaining = plan.content.expiresAtMs - Date.now();
					if (remaining <= 0) {
						setExpired(true);
						return;
					}
					setExpired(false);
					timer = setTimeout(check, Math.min(remaining, 2147483647));
				};
				check();
				return () => {
					if (timer !== void 0) clearTimeout(timer);
				};
			}, [plan.content.expiresAtMs]);
			const decide = async (decision) => {
				if (decisionClaimed.current) return;
				decisionClaimed.current = true;
				setDecisionLocked(true);
				request.current?.abort();
				const controller = new AbortController();
				request.current = controller;
				setBusy(decision);
				setError(void 0);
				try {
					const state = await management.decide(plan, decision, controller.signal);
					setPlanStatus(state.status);
					if (decision === "reject") {
						if (state.status !== "rejected") throw new Error(`decision returned ${state.status}`);
						return;
					}
					if (state.status !== "approved") throw new Error(`decision returned ${state.status}`);
					await executeApproved(controller);
				} catch (cause) {
					if (controller.signal.aborted) return;
					await reconcile(cause, controller);
				} finally {
					if (!controller.signal.aborted) setBusy(void 0);
				}
			};
			const executeApproved = async (controller) => {
				try {
					const lifecycle = await management.execute(plan.hash, controller.signal);
					setResult(lifecycle);
					onCommitted?.(lifecycle);
				} catch (cause) {
					if (controller.signal.aborted) return;
					await reconcile(cause, controller);
				}
			};
			const reconcile = async (cause, controller) => {
				try {
					const current = await management.plan(plan.hash, controller.signal);
					if (current === null) throw new Error("plan reconciliation returned absent");
					setPlanStatus(current.status);
					if (current.status === "pending" || current.status === "approved") {
						decisionClaimed.current = false;
						setDecisionLocked(false);
					}
					setError(cause instanceof Error ? cause.message : String(cause));
				} catch (reconcileCause) {
					setError(`${cause instanceof Error ? cause.message : String(cause)}; ${reconcileCause instanceof Error ? reconcileCause.message : String(reconcileCause)}`);
				}
			};
			const resume = async () => {
				if (decisionClaimed.current || planStatus !== "approved") return;
				decisionClaimed.current = true;
				setDecisionLocked(true);
				request.current?.abort();
				const controller = new AbortController();
				request.current = controller;
				setBusy("approve");
				setError(void 0);
				await executeApproved(controller);
				if (!controller.signal.aborted) setBusy(void 0);
			};
			const candidateBound = candidate !== void 0 && candidate.candidateRef === plan.content.candidateRef && candidate.kind === plan.content.extensionKind && candidate.name === plan.content.extensionId && candidate.artifact.version === plan.content.artifactRevision && candidate.artifact.integrity === plan.content.artifactIntegrity;
			const permissions = candidateBound ? candidate.permissions.filter((permission) => permission.access !== "none") : [];
			const restart = `${plan.content.restartRequired ? t("restart.required") : t("restart.notRequired")}` + (candidateBound && plan.content.restartRequired ? ` · ${localize$1(candidate.restart.detail, language)}` : "");
			const retention = candidateBound ? localize$1(candidate.retainedData, language) : t("field.notDeclared");
			return (0, react_jsx_runtime.jsxs)("section", {
				ref: surface,
				className: ExtensionCenter_module_css_default.planReview,
				"aria-labelledby": "extension-center-plan-heading",
				tabIndex: -1,
				"data-plan-hash": plan.hash,
				children: [
					(0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsxs)("div", { children: [
						(0, react_jsx_runtime.jsx)("span", { children: t("plan.eyebrow") }),
						(0, react_jsx_runtime.jsx)("h3", {
							id: "extension-center-plan-heading",
							children: t("plan.heading")
						}),
						(0, react_jsx_runtime.jsx)("p", { children: t("plan.body") })
					] }), (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: onClose,
						children: t("plan.close")
					})] }),
					policy.status === "denied" ? (0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.planDenied,
						role: "alert",
						children: [
							(0, react_jsx_runtime.jsx)("strong", { children: t("plan.denied") }),
							(0, react_jsx_runtime.jsx)("code", { children: policy.code }),
							(0, react_jsx_runtime.jsx)("p", { children: policy.reason })
						]
					}) : null,
					!candidateBound ? (0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.planDenied,
						role: "alert",
						children: [(0, react_jsx_runtime.jsx)("strong", { children: t("plan.candidateUnavailable") }), (0, react_jsx_runtime.jsx)("p", { children: t("plan.candidateUnavailable.body") })]
					}) : null,
					expired ? (0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.planDenied,
						role: "alert",
						children: [(0, react_jsx_runtime.jsx)("strong", { children: t("plan.expired") }), (0, react_jsx_runtime.jsx)("p", { children: t("plan.expired.body") })]
					}) : null,
					(0, react_jsx_runtime.jsxs)("dl", {
						className: ExtensionCenter_module_css_default.planFacts,
						children: [
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.operation") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.operationKind }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("field.type") }), (0, react_jsx_runtime.jsx)("dd", { children: plan.content.extensionKind })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.candidate") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.candidateRef }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t(plan.content.managedObject === "connection" ? "field.catalogReferenceVersion" : "field.version") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.artifactRevision }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t(plan.content.managedObject === "connection" ? "field.catalogReferenceIntegrity" : "field.integrity") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.artifactIntegrity }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.managedObject") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.managedObject }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.externalRuntimeAction") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.externalRuntimeAction }) })] }),
							plan.content.runtimeBinding === null ? null : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.runtimeRef") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.runtimeBinding.runtimeRef }) })] }),
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.runtimeVersion") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.runtimeBinding.version }) })] }),
								(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.runtimeDescriptorDigest") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.runtimeBinding.descriptorDigest }) })] })
							] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.target") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.targetKey }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.scope") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsxs)("code", { children: [
								plan.content.scopeKey,
								" / ",
								plan.content.profileId
							] }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.desired") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.desiredState }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("field.restart") }), (0, react_jsx_runtime.jsx)("dd", { children: restart })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("field.retention") }), (0, react_jsx_runtime.jsx)("dd", { children: retention })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.authorityDigest") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.authorityDigest }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.configurationDigest") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.configurationDigest }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.mutationDigest") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.mutationDigest }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.verificationDigest") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.content.verificationDigest }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.hash") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: plan.hash }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.expires") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("time", {
								dateTime: new Date(plan.content.expiresAtMs).toISOString(),
								children: new Date(plan.content.expiresAtMs).toLocaleString()
							}) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.singleUse") }), (0, react_jsx_runtime.jsx)("dd", { children: t("plan.singleUse.yes") })] })
						]
					}),
					plan.content.managedObject === "connection" ? (0, react_jsx_runtime.jsx)("p", { children: t("mcpConfig.noArtifactAcquisition") }) : null,
					(0, react_jsx_runtime.jsx)(ReviewEvidenceDetails, {
						evidence: plan.content.reviewEvidence,
						t
					}),
					(0, react_jsx_runtime.jsxs)("section", {
						className: ExtensionCenter_module_css_default.planPermissions,
						"aria-labelledby": "extension-center-plan-permissions",
						children: [(0, react_jsx_runtime.jsx)("h4", {
							id: "extension-center-plan-permissions",
							children: t("field.permissions")
						}), permissions.length === 0 ? (0, react_jsx_runtime.jsx)("p", { children: t("field.none") }) : (0, react_jsx_runtime.jsx)("ul", { children: permissions.map((permission, index) => (0, react_jsx_runtime.jsxs)("li", { children: [(0, react_jsx_runtime.jsxs)("strong", { children: [
							permission.phase,
							" · ",
							permission.kind,
							" · ",
							permission.access
						] }), (0, react_jsx_runtime.jsx)("span", { children: localize$1(permission.detail, language) })] }, `${permission.phase}-${permission.kind}-${index}`)) })]
					}),
					configuration === void 0 ? null : (0, react_jsx_runtime.jsxs)("section", {
						className: ExtensionCenter_module_css_default.configurationDiff,
						"aria-labelledby": "extension-center-plan-configuration",
						children: [
							(0, react_jsx_runtime.jsx)("h4", {
								id: "extension-center-plan-configuration",
								children: t("plan.configurationDiff")
							}),
							(0, react_jsx_runtime.jsx)("pre", { children: configurationDiff(configuration) || t("field.none") }),
							(0, react_jsx_runtime.jsxs)("p", { children: [
								t("plan.configurationDigest"),
								" ",
								(0, react_jsx_runtime.jsx)("code", { children: configDigest ?? t("plan.digesting") })
							] }),
							(0, react_jsx_runtime.jsxs)("p", { children: [
								t("field.restart"),
								" · ",
								restart
							] })
						]
					}),
					planStatus === "rejected" ? (0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.decisionResult,
						role: "status",
						children: [(0, react_jsx_runtime.jsx)("strong", { children: t("plan.rejected") }), (0, react_jsx_runtime.jsx)("p", { children: t("plan.rejected.body") })]
					}) : null,
					result === void 0 ? null : (0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.decisionResult,
						role: "status",
						children: [
							(0, react_jsx_runtime.jsx)("strong", { children: result.status === "recovery-required" ? t("recovery.required") : result.status === "restart-required" ? t("operation.restartRequired") : t("operation.started") }),
							result.status === "recovery-required" ? (0, react_jsx_runtime.jsx)("p", { children: t("recovery.required.body") }) : null,
							(0, react_jsx_runtime.jsxs)("p", { children: [
								t("operation.id"),
								" ",
								(0, react_jsx_runtime.jsx)("code", { children: result.operationId }),
								" · ",
								t("operation.phase"),
								" ",
								(0, react_jsx_runtime.jsx)("code", { children: result.status })
							] }),
							result.receipt === null ? null : (0, react_jsx_runtime.jsxs)("p", { children: [
								t("receipt.digest"),
								" ",
								(0, react_jsx_runtime.jsx)("code", { children: result.receipt.digest })
							] })
						]
					}),
					error === void 0 ? null : (0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.mutationError,
						role: "alert",
						children: [
							(0, react_jsx_runtime.jsx)("strong", { children: t("operation.uncertain") }),
							(0, react_jsx_runtime.jsx)("p", { children: planStatus === "pending" ? t("operation.notRecorded") : t("operation.uncertain.body") }),
							(0, react_jsx_runtime.jsx)("code", { children: error })
						]
					}),
					policy.status === "eligible" && planStatus === "pending" && result === void 0 ? (0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.decisionActions,
						"aria-label": t("plan.decision"),
						children: [(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							disabled: busy !== void 0 || decisionLocked,
							onClick: () => {
								decide("reject");
							},
							children: busy === "reject" ? t("plan.rejecting") : t("plan.reject")
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: ExtensionCenter_module_css_default.primaryAction,
							disabled: busy !== void 0 || decisionLocked || !candidateBound || expired,
							title: !candidateBound ? t("plan.candidateUnavailable") : expired ? t("plan.expired") : void 0,
							onClick: () => {
								decide("approve");
							},
							children: busy === "approve" ? t("plan.approving") : t("plan.approve")
						})]
					}) : null,
					policy.status === "eligible" && planStatus === "approved" && result === void 0 ? (0, react_jsx_runtime.jsx)("div", {
						className: ExtensionCenter_module_css_default.decisionActions,
						"aria-label": t("plan.decision"),
						children: (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							className: ExtensionCenter_module_css_default.primaryAction,
							disabled: busy !== void 0 || decisionLocked || !candidateBound,
							onClick: () => {
								resume();
							},
							children: busy === "approve" ? t("operation.resuming") : t("operation.resume")
						})
					}) : null
				]
			});
		}
		//#endregion
		//#region lib/.build/client/ResolverConfigDraft.js
		const FIELDS = [
			[
				"freshCacheMs",
				1e3,
				864e5,
				9e5
			],
			[
				"staleCacheMs",
				1e3,
				6048e5,
				864e5
			],
			[
				"fetchTimeoutMs",
				100,
				6e4,
				5e3
			],
			[
				"maxCatalogBytes",
				65536,
				33554432,
				8388608
			],
			[
				"maxCatalogEntries",
				1,
				2e4,
				5e3
			],
			[
				"maxTaskChars",
				64,
				16e3,
				2e3
			],
			[
				"maxResults",
				1,
				50,
				8
			],
			[
				"maxCurrentMatches",
				1,
				50,
				8
			],
			[
				"maxMatchedTerms",
				1,
				50,
				12
			],
			[
				"maxDescriptionChars",
				80,
				4e3,
				600
			]
		];
		function initialDraft(value) {
			const input = typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
			return Object.fromEntries(FIELDS.map(([name, minimum, maximum, initial]) => {
				const selected = input[name];
				return [name, String(Number.isSafeInteger(selected) && selected >= minimum && selected <= maximum ? selected : initial)];
			}));
		}
		/** Convert the exact typed draft into the only configuration keys accepted by this Client adapter. */
		function resolverConfiguration(draft) {
			const output = {};
			for (const [name, minimum, maximum] of FIELDS) {
				const value = Number(draft[name]);
				if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(name);
				output[name] = value;
			}
			if (output.staleCacheMs < output.freshCacheMs) throw new Error("staleCacheMs");
			return output;
		}
		/** Typed staged draft for the admitted capability-resolver configuration adapter. */
		function ResolverConfigDraft({ initial, t, onSave, onDiscard }) {
			const [draft, setDraft] = (0, react.useState)(() => initialDraft(initial));
			const [error, setError] = (0, react.useState)();
			return (0, react_jsx_runtime.jsxs)("section", {
				className: ExtensionCenter_module_css_default.configurationDraft,
				"aria-labelledby": "resolver-config-draft-heading",
				children: [
					(0, react_jsx_runtime.jsx)("h5", {
						id: "resolver-config-draft-heading",
						children: t("resolverConfig.heading")
					}),
					(0, react_jsx_runtime.jsx)("p", { children: t("resolverConfig.body") }),
					(0, react_jsx_runtime.jsx)("div", {
						className: ExtensionCenter_module_css_default.typedConfigGrid,
						children: FIELDS.map(([name, minimum, maximum]) => (0, react_jsx_runtime.jsxs)("label", { children: [
							(0, react_jsx_runtime.jsx)("span", { children: (0, react_jsx_runtime.jsx)("code", { children: name }) }),
							(0, react_jsx_runtime.jsx)("input", {
								type: "number",
								inputMode: "numeric",
								step: "1",
								min: minimum,
								max: maximum,
								value: draft[name],
								"aria-describedby": `resolver-config-${name}-constraint`,
								onChange: (event) => {
									const value = event.currentTarget.value;
									setDraft((current) => ({
										...current,
										[name]: value
									}));
								}
							}),
							(0, react_jsx_runtime.jsxs)("small", {
								id: `resolver-config-${name}-constraint`,
								children: [
									minimum,
									"…",
									maximum
								]
							})
						] }, name))
					}),
					(0, react_jsx_runtime.jsx)("p", { children: t("resolverConfig.staleRule") }),
					error === void 0 ? null : (0, react_jsx_runtime.jsxs)("div", {
						role: "alert",
						children: [
							t("resolverConfig.invalid"),
							" ",
							(0, react_jsx_runtime.jsx)("code", { children: error })
						]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.inlineActions,
						children: [(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => {
								try {
									const configuration = resolverConfiguration(draft);
									setError(void 0);
									onSave(configuration);
								} catch (cause) {
									setError(cause instanceof Error ? cause.message : String(cause));
								}
							},
							children: t("configure.save")
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: onDiscard,
							children: t("configure.discard")
						})]
					})
				]
			});
		}
		/** Read-only typed schema shown in candidate details before configuration begins. */
		function ResolverConfigDisclosure({ t }) {
			return (0, react_jsx_runtime.jsxs)("section", {
				className: ExtensionCenter_module_css_default.disclosure,
				"aria-labelledby": "resolver-config-schema-heading",
				children: [
					(0, react_jsx_runtime.jsx)("h4", {
						id: "resolver-config-schema-heading",
						children: t("resolverConfig.schema")
					}),
					(0, react_jsx_runtime.jsx)("ul", { children: FIELDS.map(([name, minimum, maximum]) => (0, react_jsx_runtime.jsxs)("li", { children: [(0, react_jsx_runtime.jsx)("strong", { children: (0, react_jsx_runtime.jsx)("code", { children: name }) }), (0, react_jsx_runtime.jsxs)("span", { children: [
						t("resolverConfig.integer"),
						" · ",
						minimum,
						"…",
						maximum
					] })] }, name)) }),
					(0, react_jsx_runtime.jsx)("p", { children: t("resolverConfig.staleRule") })
				]
			});
		}
		//#endregion
		//#region lib/.build/client/TypedConfigurationDrafts.js
		function object(value) {
			return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
		}
		function integer(value, minimum, maximum, field) {
			const parsed = Number(value);
			if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(field);
			return parsed;
		}
		function absolutePath(value) {
			return value.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");
		}
		/** Typed Skill target and invocation configuration. */
		function SkillConfigurationDraft({ scopeKey, initial, t, onSave, onDiscard }) {
			const prior = object(initial);
			const [modelInvocable, setModelInvocable] = (0, react.useState)(prior?.modelInvocable !== false);
			const [userInvocable, setUserInvocable] = (0, react.useState)(prior?.userInvocable !== false);
			const [projectRoot, setProjectRoot] = (0, react.useState)(typeof prior?.projectRoot === "string" ? prior.projectRoot : "");
			const [error, setError] = (0, react.useState)();
			const project = scopeKey === "project";
			return (0, react_jsx_runtime.jsxs)("section", {
				className: ExtensionCenter_module_css_default.configurationDraft,
				"aria-labelledby": "skill-config-draft-heading",
				children: [
					(0, react_jsx_runtime.jsx)("h5", {
						id: "skill-config-draft-heading",
						children: t("skillConfig.heading")
					}),
					(0, react_jsx_runtime.jsx)("p", { children: t("skillConfig.body") }),
					project ? (0, react_jsx_runtime.jsxs)("label", { children: [
						(0, react_jsx_runtime.jsx)("span", { children: t("skillConfig.projectRoot") }),
						(0, react_jsx_runtime.jsx)("input", {
							value: projectRoot,
							onChange: (event) => {
								setProjectRoot(event.currentTarget.value);
							}
						}),
						(0, react_jsx_runtime.jsx)("small", { children: t("skillConfig.projectRoot.body") })
					] }) : null,
					(0, react_jsx_runtime.jsxs)("label", { children: [
						(0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: modelInvocable,
							onChange: (event) => {
								setModelInvocable(event.currentTarget.checked);
							}
						}),
						" ",
						t("skillConfig.modelInvocable")
					] }),
					(0, react_jsx_runtime.jsxs)("label", { children: [
						(0, react_jsx_runtime.jsx)("input", {
							type: "checkbox",
							checked: userInvocable,
							onChange: (event) => {
								setUserInvocable(event.currentTarget.checked);
							}
						}),
						" ",
						t("skillConfig.userInvocable")
					] }),
					error === void 0 ? null : (0, react_jsx_runtime.jsxs)("div", {
						role: "alert",
						children: [
							t("configure.invalid"),
							" ",
							(0, react_jsx_runtime.jsx)("code", { children: error })
						]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.inlineActions,
						children: [(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => {
								const root = projectRoot.trim();
								if (project && (!absolutePath(root) || root.includes("\0"))) {
									setError("projectRoot");
									return;
								}
								setError(void 0);
								onSave({
									modelInvocable,
									userInvocable,
									projectRoot: project ? root : null
								});
							},
							children: t("configure.save")
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: onDiscard,
							children: t("configure.discard")
						})]
					})
				]
			});
		}
		/** Typed MCP connection over one Host-provisioned runtime selector. */
		function McpConfigurationDraft({ options, initial, t, onSave, onDiscard }) {
			const prior = object(initial);
			const reconnect = object(prior?.reconnect ?? null);
			const [runtimeRef, setRuntimeRef] = (0, react.useState)(typeof prior?.runtimeRef === "string" && options.some((option) => option.runtimeRef === prior.runtimeRef) ? prior.runtimeRef : options[0]?.runtimeRef ?? "");
			const [connectionId, setConnectionId] = (0, react.useState)(typeof prior?.connectionId === "string" ? prior.connectionId : "filesystem");
			const [roots, setRoots] = (0, react.useState)(Array.isArray(prior?.roots) && prior.roots.every((root) => typeof root === "string") ? prior.roots.join("\n") : "");
			const [toolCallTimeoutMs, setToolCallTimeoutMs] = (0, react.useState)(String(typeof prior?.toolCallTimeoutMs === "number" ? prior.toolCallTimeoutMs : 3e4));
			const [reconnectEnabled, setReconnectEnabled] = (0, react.useState)(reconnect?.enabled !== false);
			const [initialDelayMs, setInitialDelayMs] = (0, react.useState)(String(typeof reconnect?.initialDelayMs === "number" ? reconnect.initialDelayMs : 250));
			const [maxDelayMs, setMaxDelayMs] = (0, react.useState)(String(typeof reconnect?.maxDelayMs === "number" ? reconnect.maxDelayMs : 5e3));
			const [maxAttempts, setMaxAttempts] = (0, react.useState)(String(typeof reconnect?.maxAttempts === "number" ? reconnect.maxAttempts : 8));
			const [error, setError] = (0, react.useState)();
			const selected = (0, react.useMemo)(() => options.find((option) => option.runtimeRef === runtimeRef), [options, runtimeRef]);
			return (0, react_jsx_runtime.jsxs)("section", {
				className: ExtensionCenter_module_css_default.configurationDraft,
				"aria-labelledby": "mcp-config-draft-heading",
				children: [
					(0, react_jsx_runtime.jsx)("h5", {
						id: "mcp-config-draft-heading",
						children: t("mcpConfig.heading")
					}),
					(0, react_jsx_runtime.jsx)("p", { children: t("mcpConfig.body") }),
					options.length === 0 ? (0, react_jsx_runtime.jsxs)("div", {
						role: "alert",
						children: [(0, react_jsx_runtime.jsx)("strong", { children: t("mcpConfig.runtimeMissing") }), (0, react_jsx_runtime.jsx)("p", { children: t("mcpConfig.runtimeMissing.body") })]
					}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
						(0, react_jsx_runtime.jsxs)("label", { children: [(0, react_jsx_runtime.jsx)("span", { children: t("mcpConfig.runtime") }), (0, react_jsx_runtime.jsx)("select", {
							value: runtimeRef,
							onChange: (event) => {
								setRuntimeRef(event.currentTarget.value);
							},
							children: options.map((option) => (0, react_jsx_runtime.jsxs)("option", {
								value: option.runtimeRef,
								children: [
									option.runtimeRef,
									" · ",
									option.version,
									" · ",
									option.transport
								]
							}, option.runtimeRef))
						})] }),
						(0, react_jsx_runtime.jsxs)("label", { children: [(0, react_jsx_runtime.jsx)("span", { children: t("mcpConfig.connectionId") }), (0, react_jsx_runtime.jsx)("input", {
							value: connectionId,
							maxLength: 32,
							onChange: (event) => {
								setConnectionId(event.currentTarget.value);
							}
						})] }),
						selected?.transport === "stdio" ? (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
							(0, react_jsx_runtime.jsxs)("p", { children: [
								(0, react_jsx_runtime.jsx)("strong", { children: t("mcpConfig.executable") }),
								" ",
								(0, react_jsx_runtime.jsx)("code", { children: selected.executablePath })
							] }),
							(0, react_jsx_runtime.jsxs)("p", { children: [
								(0, react_jsx_runtime.jsx)("strong", { children: t("mcpConfig.arguments") }),
								" ",
								(0, react_jsx_runtime.jsx)("code", { children: selected.fixedArgs.join(" ") || t("mcpConfig.none") })
							] }),
							(0, react_jsx_runtime.jsxs)("p", { children: [
								(0, react_jsx_runtime.jsx)("strong", { children: t("mcpConfig.workingDirectory") }),
								" ",
								(0, react_jsx_runtime.jsx)("code", { children: selected.workingDirectory })
							] }),
							(0, react_jsx_runtime.jsxs)("label", { children: [
								(0, react_jsx_runtime.jsx)("span", { children: t("mcpConfig.roots") }),
								(0, react_jsx_runtime.jsx)("textarea", {
									value: roots,
									onChange: (event) => {
										setRoots(event.currentTarget.value);
									}
								}),
								(0, react_jsx_runtime.jsx)("small", { children: t("mcpConfig.roots.body") })
							] })
						] }) : selected?.transport === "streamable-http" ? (0, react_jsx_runtime.jsxs)("aside", { children: [
							(0, react_jsx_runtime.jsxs)("p", { children: [
								(0, react_jsx_runtime.jsx)("strong", { children: t("mcpConfig.origin") }),
								" ",
								(0, react_jsx_runtime.jsx)("code", { children: selected.origin })
							] }),
							(0, react_jsx_runtime.jsxs)("p", { children: [
								(0, react_jsx_runtime.jsx)("strong", { children: t("mcpConfig.endpoint") }),
								" ",
								(0, react_jsx_runtime.jsx)("code", { children: selected.endpoint })
							] }),
							(0, react_jsx_runtime.jsxs)("p", { children: [
								(0, react_jsx_runtime.jsx)("strong", { children: t("mcpConfig.dataEgress") }),
								" ",
								selected.dataEgressDisclosure
							] }),
							(0, react_jsx_runtime.jsx)("p", { children: t("mcpConfig.httpPolicy") })
						] }) : null,
						(0, react_jsx_runtime.jsxs)("label", { children: [(0, react_jsx_runtime.jsx)("span", { children: t("mcpConfig.timeout") }), (0, react_jsx_runtime.jsx)("input", {
							type: "number",
							min: "100",
							max: "300000",
							step: "1",
							value: toolCallTimeoutMs,
							onChange: (event) => {
								setToolCallTimeoutMs(event.currentTarget.value);
							}
						})] }),
						(0, react_jsx_runtime.jsxs)("label", { children: [
							(0, react_jsx_runtime.jsx)("input", {
								type: "checkbox",
								checked: reconnectEnabled,
								onChange: (event) => {
									setReconnectEnabled(event.currentTarget.checked);
								}
							}),
							" ",
							t("mcpConfig.reconnect")
						] }),
						(0, react_jsx_runtime.jsxs)("div", {
							className: ExtensionCenter_module_css_default.typedConfigGrid,
							children: [
								(0, react_jsx_runtime.jsxs)("label", { children: [(0, react_jsx_runtime.jsx)("span", { children: t("mcpConfig.initialDelay") }), (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: "50",
									max: "60000",
									step: "1",
									value: initialDelayMs,
									onChange: (event) => {
										setInitialDelayMs(event.currentTarget.value);
									}
								})] }),
								(0, react_jsx_runtime.jsxs)("label", { children: [(0, react_jsx_runtime.jsx)("span", { children: t("mcpConfig.maxDelay") }), (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: "50",
									max: "300000",
									step: "1",
									value: maxDelayMs,
									onChange: (event) => {
										setMaxDelayMs(event.currentTarget.value);
									}
								})] }),
								(0, react_jsx_runtime.jsxs)("label", { children: [(0, react_jsx_runtime.jsx)("span", { children: t("mcpConfig.maxAttempts") }), (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: "1",
									max: "100",
									step: "1",
									value: maxAttempts,
									onChange: (event) => {
										setMaxAttempts(event.currentTarget.value);
									}
								})] })
							]
						}),
						(0, react_jsx_runtime.jsxs)("p", { children: [
							t("mcpConfig.selected"),
							" ",
							(0, react_jsx_runtime.jsx)("code", { children: selected?.candidateRef ?? runtimeRef })
						] })
					] }),
					error === void 0 ? null : (0, react_jsx_runtime.jsxs)("div", {
						role: "alert",
						children: [
							t("configure.invalid"),
							" ",
							(0, react_jsx_runtime.jsx)("code", { children: error })
						]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.inlineActions,
						children: [(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							disabled: options.length === 0,
							onClick: () => {
								try {
									if (!/^[A-Za-z0-9_-]{1,32}$/u.test(connectionId) || selected === void 0) throw new Error("connectionId/runtimeRef");
									const initialDelay = integer(initialDelayMs, 50, 6e4, "initialDelayMs");
									const maxDelay = integer(maxDelayMs, 50, 3e5, "maxDelayMs");
									if (initialDelay > maxDelay) throw new Error("reconnect delay");
									setError(void 0);
									const common = {
										connectionId,
										runtimeRef,
										toolCallTimeoutMs: integer(toolCallTimeoutMs, 100, 3e5, "toolCallTimeoutMs"),
										reconnect: {
											enabled: reconnectEnabled,
											initialDelayMs: initialDelay,
											maxDelayMs: maxDelay,
											maxAttempts: integer(maxAttempts, 1, 100, "maxAttempts")
										}
									};
									if (selected.transport === "stdio") {
										const canonicalRoots = [...new Set(roots.split(/\r?\n/u).map((root) => root.trim()).filter(Boolean))];
										if (canonicalRoots.length === 0 || canonicalRoots.length > 16 || canonicalRoots.some((root) => !absolutePath(root) || root.includes("\0"))) throw new Error("roots");
										onSave({
											...common,
											roots: canonicalRoots,
											transport: "stdio"
										});
									} else onSave({
										...common,
										transport: "streamable-http"
									});
								} catch (cause) {
									setError(cause instanceof Error ? cause.message : String(cause));
								}
							},
							children: t("configure.save")
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: onDiscard,
							children: t("configure.discard")
						})]
					})
				]
			});
		}
		//#endregion
		//#region lib/.build/client/ManagementPanels.js
		const ACTIONS = [
			"install",
			"configure",
			"update",
			"enable",
			"disable",
			"uninstall",
			"restore",
			"purge"
		];
		const RETRY_CONTINUATION_KEYS = {
			pending: "taskAttempt.retryContinuation.pending",
			ready: "taskAttempt.retryContinuation.ready",
			consumed: "taskAttempt.retryContinuation.consumed",
			dispatching: "taskAttempt.retryContinuation.dispatching",
			dispatched: "taskAttempt.retryContinuation.dispatched",
			claimed: "taskAttempt.retryContinuation.claimed",
			"delivery-unknown": "taskAttempt.retryContinuation.deliveryUnknown",
			canceled: "taskAttempt.retryContinuation.canceled",
			superseded: "taskAttempt.retryContinuation.superseded",
			expired: "taskAttempt.retryContinuation.expired",
			invalid: "taskAttempt.retryContinuation.invalid",
			reconciling: "taskAttempt.retryContinuation.reconciling",
			unavailable: "taskAttempt.retryContinuation.unavailable"
		};
		const CANCELABLE_RETRY_CONTINUATION_STATES = /* @__PURE__ */ new Set([
			"pending",
			"ready",
			"consumed",
			"reconciling"
		]);
		function message(cause) {
			return cause instanceof Error ? cause.message : String(cause);
		}
		function useInventory(management, context, scopeKey, attempt) {
			const [state, setState] = (0, react.useState)({ status: management === void 0 ? "unavailable" : "loading" });
			(0, react.useEffect)(() => {
				if (management === void 0) {
					setState({ status: "unavailable" });
					return;
				}
				const controller = new AbortController();
				setState({ status: "loading" });
				management.inventory(scopeKey, context.profileId, controller.signal).then((value) => {
					setState({
						status: "ready",
						value
					});
				}).catch((cause) => {
					if (!controller.signal.aborted) setState({
						status: "error",
						error: message(cause)
					});
				});
				return () => {
					controller.abort();
				};
			}, [
				attempt,
				context.profileId,
				management,
				scopeKey
			]);
			return state;
		}
		function ManagementScopePicker({ value, t, onChange }) {
			return (0, react_jsx_runtime.jsxs)("label", { children: [(0, react_jsx_runtime.jsx)("span", { children: t("filter.scope") }), (0, react_jsx_runtime.jsxs)("select", {
				value,
				onChange: (event) => {
					onChange(event.currentTarget.value);
				},
				children: [
					(0, react_jsx_runtime.jsx)("option", {
						value: "profile:web",
						children: t("scope.profile")
					}),
					(0, react_jsx_runtime.jsx)("option", {
						value: "user",
						children: t("scope.user")
					}),
					(0, react_jsx_runtime.jsx)("option", {
						value: "project",
						children: t("scope.project")
					})
				]
			})] });
		}
		/** Preview one exact mutation before exposing the separate human decision. */
		function MutationFlow({ request: input, candidate, management, t, onClose, onCommitted }) {
			const returnFocus = (0, react.useRef)(input.returnFocus ?? (typeof document === "undefined" || !(document.activeElement instanceof HTMLElement) ? null : document.activeElement));
			const [attempt, setAttempt] = (0, react.useState)(0);
			const [state, setState] = (0, react.useState)({ status: "loading" });
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				setState({ status: "loading" });
				management.preview({
					candidateRef: input.candidateRef,
					operationKind: input.operationKind,
					scopeKey: input.scopeKey,
					profileId: input.profileId,
					targetKey: input.targetKey,
					configuration: input.configuration
				}, controller.signal).then((preview) => {
					setState({
						status: "ready",
						preview
					});
				}).catch((cause) => {
					if (!controller.signal.aborted) setState({
						status: "error",
						error: message(cause)
					});
				});
				return () => {
					controller.abort();
				};
			}, [
				attempt,
				input,
				management
			]);
			(0, react.useEffect)(() => () => {
				returnFocus.current?.focus();
			}, []);
			if (state.status === "loading") return (0, react_jsx_runtime.jsx)("div", {
				className: ExtensionCenter_module_css_default.managementLoading,
				role: "status",
				children: t("plan.loading")
			});
			if (state.status === "error") return (0, react_jsx_runtime.jsxs)("div", {
				className: ExtensionCenter_module_css_default.managementError,
				role: "alert",
				children: [
					(0, react_jsx_runtime.jsx)("strong", { children: t("plan.unavailable") }),
					(0, react_jsx_runtime.jsx)("p", { children: t("plan.unavailable.body") }),
					(0, react_jsx_runtime.jsx)("code", { children: state.error }),
					(0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.inlineActions,
						children: [(0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: () => {
								setAttempt((value) => value + 1);
							},
							children: t("action.retry")
						}), (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: onClose,
							children: t("action.cancel")
						})]
					})
				]
			});
			return (0, react_jsx_runtime.jsx)(PlanReview, {
				preview: state.preview,
				candidate,
				management,
				configuration: input.configuration,
				t,
				onClose,
				onCommitted
			});
		}
		function ManagementUnavailable({ t, capabilities }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ExtensionCenter_module_css_default.empty,
				role: "status",
				children: [
					(0, react_jsx_runtime.jsx)("h3", { children: t("lifecycle.heading") }),
					(0, react_jsx_runtime.jsx)("p", { children: t("lifecycle.body") }),
					(0, react_jsx_runtime.jsx)("code", { children: t("lifecycle.code") }),
					capabilities === void 0 ? null : (0, react_jsx_runtime.jsx)(HostCapabilityStatus, {
						capabilities,
						t
					})
				]
			});
		}
		function ManagementError({ error, t, onRetry }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ExtensionCenter_module_css_default.managementError,
				role: "alert",
				children: [
					(0, react_jsx_runtime.jsx)("strong", { children: t("management.unavailable") }),
					(0, react_jsx_runtime.jsx)("p", { children: t("management.unavailable.body") }),
					error === void 0 ? null : (0, react_jsx_runtime.jsx)("code", { children: error }),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: onRetry,
						children: t("management.retry")
					})
				]
			});
		}
		function stateFact(label, value) {
			return (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: label }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: value }) })] });
		}
		function TaskConfigurationFlow({ row, management, t, onClose, onCreated }) {
			const [state, setState] = (0, react.useState)({ status: "loading" });
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				setState({ status: "loading" });
				management.configurationOptions({
					candidateRef: row.candidateRef,
					operationKind: "install",
					targetKey: null,
					scopeKey: row.scopeKey,
					profileId: row.profileId
				}, controller.signal).then((response) => {
					setState({
						status: "ready",
						options: response.options
					});
				}).catch((cause) => {
					if (!controller.signal.aborted) setState({
						status: "error",
						error: message(cause)
					});
				});
				return () => {
					controller.abort();
				};
			}, [management, row]);
			if (state.status === "loading") return (0, react_jsx_runtime.jsx)("div", {
				className: ExtensionCenter_module_css_default.managementLoading,
				role: "status",
				children: t("activity.loading")
			});
			if (state.status === "saving") return (0, react_jsx_runtime.jsx)("div", {
				className: ExtensionCenter_module_css_default.managementLoading,
				role: "status",
				children: t("approval.configuration.saving")
			});
			if (state.status === "error") return (0, react_jsx_runtime.jsxs)("div", {
				className: ExtensionCenter_module_css_default.managementError,
				role: "alert",
				children: [
					(0, react_jsx_runtime.jsx)("strong", { children: t("plan.unavailable") }),
					(0, react_jsx_runtime.jsx)("code", { children: state.error }),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: onClose,
						children: t("action.cancel")
					})
				]
			});
			return (0, react_jsx_runtime.jsx)(McpConfigurationDraft, {
				options: state.options ?? [],
				initial: null,
				t,
				onDiscard: onClose,
				onSave: (configuration) => {
					setState((current) => ({
						...current,
						status: "saving",
						error: void 0
					}));
					management.configureTask({
						resolutionId: row.resolutionId,
						candidateRef: row.candidateRef,
						continuationId: row.continuationId,
						configuration
					}).then((response) => {
						onCreated(response.plan.hash);
					}).catch((cause) => {
						setState((current) => ({
							...current,
							status: "error",
							error: message(cause)
						}));
					});
				}
			});
		}
		function actionTitle(row, operation, t) {
			const availability = row.actions[operation];
			if (availability.status === "available") return t("lifecycle.available");
			return `${availability.status}(${availability.reason})`;
		}
		function candidateForAction(row, operation) {
			if (operation === "update" && row.updateObservation.status === "available") return row.updateObservation.candidateRef;
			if (operation === "restore" && row.restoreObservation.status === "available") return row.restoreObservation.candidateRef;
			return row.candidateRef;
		}
		/** Managed inventory with independent lifecycle dimensions and staged configuration. */
		function InstalledPanel({ management, context, candidates, t }) {
			const [attempt, setAttempt] = (0, react.useState)(0);
			const [scopeKey, setScopeKey] = (0, react.useState)(context.defaultScopeKey);
			const inventory = useInventory(management, context, scopeKey, attempt);
			const [mutation, setMutation] = (0, react.useState)();
			const [configurationState, setConfigurationState] = (0, react.useState)();
			const [verificationState, setVerificationState] = (0, react.useState)();
			if (inventory.status === "unavailable") return (0, react_jsx_runtime.jsx)(ManagementUnavailable, { t });
			if (inventory.status === "loading") return (0, react_jsx_runtime.jsx)("div", {
				className: ExtensionCenter_module_css_default.managementLoading,
				role: "status",
				children: t("inventory.loading")
			});
			if (inventory.status === "error") return (0, react_jsx_runtime.jsx)(ManagementError, {
				error: inventory.error,
				t,
				onRetry: () => {
					setAttempt((value) => value + 1);
				}
			});
			const response = inventory.value;
			const rows = response.inventory.rows;
			const writable = response.hostCapabilities.acquisition;
			const launch = (row, operationKind, configuration = {}, returnFocus) => {
				const candidateRef = candidateForAction(row, operationKind);
				if (candidateRef === null) return;
				setMutation({
					id: `${row.targetKey}:${operationKind}:${String(Date.now())}`,
					candidateRef,
					operationKind,
					scopeKey: row.scopeKey,
					profileId: row.profileId,
					targetKey: row.targetKey,
					configuration,
					returnFocus
				});
			};
			const prepareLifecycle = (row, operationKind, returnFocus) => {
				if (management === void 0) return;
				const candidateRef = candidateForAction(row, operationKind);
				if (candidateRef === null) return;
				const controller = new AbortController();
				setConfigurationState({
					row,
					operationKind,
					returnFocus,
					status: "loading",
					options: [],
					currentConfiguration: null
				});
				management.configurationOptions({
					candidateRef,
					operationKind,
					targetKey: row.targetKey,
					scopeKey: row.scopeKey,
					profileId: row.profileId
				}, controller.signal).then((response) => {
					if (operationKind === "configure") setConfigurationState({
						row,
						operationKind,
						returnFocus,
						status: "ready",
						options: response.options,
						currentConfiguration: response.currentConfiguration
					});
					else {
						setConfigurationState(void 0);
						launch(row, operationKind, response.currentConfiguration ?? {}, returnFocus);
					}
				}).catch((cause) => {
					setConfigurationState({
						row,
						operationKind,
						returnFocus,
						status: "error",
						options: [],
						currentConfiguration: null,
						error: message(cause)
					});
				});
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ExtensionCenter_module_css_default.managementPanel,
				children: [
					(0, react_jsx_runtime.jsxs)("header", {
						className: ExtensionCenter_module_css_default.panelHeading,
						children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("h3", { children: t("installed.heading") }), (0, react_jsx_runtime.jsx)("p", { children: t("installed.body") })] }), (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)(ManagementScopePicker, {
							value: scopeKey,
							t,
							onChange: (value) => {
								setMutation(void 0);
								setConfigurationState(void 0);
								setScopeKey(value);
							}
						}), (0, react_jsx_runtime.jsx)("code", { children: response.inventory.revision })] })]
					}),
					!response.inventory.complete ? (0, react_jsx_runtime.jsx)("div", {
						className: ExtensionCenter_module_css_default.inventoryWarning,
						role: "status",
						children: t("inventory.incomplete")
					}) : null,
					!response.hostCapabilities.acquisition ? (0, react_jsx_runtime.jsx)(ManagementUnavailable, {
						t,
						capabilities: response.hostCapabilities
					}) : null,
					rows.length === 0 ? (0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.empty,
						children: [(0, react_jsx_runtime.jsx)("h3", { children: t("inventory.empty") }), (0, react_jsx_runtime.jsx)("p", { children: t("inventory.empty.body") })]
					}) : (0, react_jsx_runtime.jsx)("div", {
						className: ExtensionCenter_module_css_default.inventoryList,
						"aria-label": t("inventory.list"),
						children: rows.map((row) => (0, react_jsx_runtime.jsxs)("article", {
							className: ExtensionCenter_module_css_default.inventoryCard,
							"data-target-key": row.targetKey,
							children: [
								(0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsxs)("div", { children: [
									(0, react_jsx_runtime.jsx)("span", { children: row.kind }),
									(0, react_jsx_runtime.jsx)("h4", { children: row.extensionId }),
									(0, react_jsx_runtime.jsx)("code", { children: row.managedRevision })
								] }), (0, react_jsx_runtime.jsx)("span", {
									"data-ownership": row.ownership,
									children: row.ownership
								})] }),
								(0, react_jsx_runtime.jsxs)("dl", {
									className: ExtensionCenter_module_css_default.stateGrid,
									children: [
										stateFact(t("state.desired"), row.desired),
										stateFact(t("state.materialized"), row.materialized),
										stateFact(t("state.effective"), row.effective),
										stateFact(t("state.visibility"), row.agentVisibility),
										stateFact(t("state.verification"), row.verification),
										stateFact(t("state.rollback"), row.rollback),
										stateFact(t("state.ownership"), row.ownership),
										stateFact(t("state.configuration"), row.configurationRevision ?? t("field.notDeclared"))
									]
								}),
								(0, react_jsx_runtime.jsxs)("p", {
									className: ExtensionCenter_module_css_default.targetLine,
									children: [
										t("plan.target"),
										" ",
										(0, react_jsx_runtime.jsx)("code", { children: row.targetKey }),
										" · ",
										t("plan.scope"),
										" ",
										(0, react_jsx_runtime.jsx)("code", { children: row.scopeKey })
									]
								}),
								row.updateObservation.status === "available" ? (0, react_jsx_runtime.jsxs)("p", {
									className: ExtensionCenter_module_css_default.updateTarget,
									children: [
										t("updates.exactTarget"),
										" ",
										(0, react_jsx_runtime.jsx)("code", { children: row.updateObservation.revision }),
										" · ",
										(0, react_jsx_runtime.jsx)("code", { children: row.updateObservation.integrity })
									]
								}) : null,
								(0, react_jsx_runtime.jsxs)("div", {
									className: ExtensionCenter_module_css_default.lifecycleActions,
									"aria-label": `${row.extensionId} ${t("field.lifecycle")}`,
									children: [(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: verificationState?.targetKey === row.targetKey && verificationState.status === "running",
										onClick: () => {
											if (management === void 0) return;
											setVerificationState({
												targetKey: row.targetKey,
												status: "running"
											});
											management.verify(row.scopeKey, row.profileId, row.targetKey).then(() => {
												setVerificationState(void 0);
												setAttempt((value) => value + 1);
											}).catch((cause) => {
												setVerificationState({
													targetKey: row.targetKey,
													status: "error",
													error: message(cause)
												});
											});
										},
										children: verificationState?.targetKey === row.targetKey && verificationState.status === "running" ? t("inventory.verify.running") : t("action.verify")
									}), ACTIONS.map((operation) => {
										const availability = row.actions[operation];
										const candidateRef = candidateForAction(row, operation);
										return (0, react_jsx_runtime.jsx)("button", {
											type: "button",
											disabled: !writable || availability.status !== "available" || candidateRef === null,
											title: !writable ? t("lifecycle.code") : candidateRef === null ? t("action.noCandidate") : actionTitle(row, operation, t),
											onClick: (event) => {
												prepareLifecycle(row, operation, event.currentTarget);
											},
											children: t(`action.${operation}`)
										}, operation);
									})]
								}),
								verificationState?.targetKey === row.targetKey && verificationState.status === "error" ? (0, react_jsx_runtime.jsxs)("div", {
									className: ExtensionCenter_module_css_default.managementError,
									role: "alert",
									children: [(0, react_jsx_runtime.jsx)("strong", { children: t("inventory.verify.failed") }), (0, react_jsx_runtime.jsx)("code", { children: verificationState.error })]
								}) : null,
								configurationState?.row.targetKey !== row.targetKey ? null : configurationState.status === "loading" ? (0, react_jsx_runtime.jsx)("div", {
									role: "status",
									children: t("inventory.loading")
								}) : configurationState.status === "error" ? (0, react_jsx_runtime.jsxs)("div", {
									className: ExtensionCenter_module_css_default.managementError,
									role: "alert",
									children: [
										(0, react_jsx_runtime.jsx)("strong", { children: t("management.unavailable") }),
										(0, react_jsx_runtime.jsx)("code", { children: configurationState.error }),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											onClick: () => {
												setConfigurationState(void 0);
												configurationState.returnFocus.focus();
											},
											children: t("action.cancel")
										})
									]
								}) : row.candidateRef !== null && isCapabilityResolverCandidate(row.candidateRef) ? (0, react_jsx_runtime.jsx)(ResolverConfigDraft, {
									initial: configurationState.currentConfiguration ?? void 0,
									t,
									onSave: (configuration) => {
										launch(row, "configure", configuration, configurationState.returnFocus);
									},
									onDiscard: () => {
										setConfigurationState(void 0);
										configurationState.returnFocus.focus();
									}
								}) : row.kind === "plugin" ? (0, react_jsx_runtime.jsxs)("div", {
									className: ExtensionCenter_module_css_default.managementError,
									role: "alert",
									children: [
										(0, react_jsx_runtime.jsx)("strong", { children: t("management.unavailable") }),
										(0, react_jsx_runtime.jsx)("code", { children: row.candidateRef ?? row.extensionId }),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											onClick: () => {
												setConfigurationState(void 0);
												configurationState.returnFocus.focus();
											},
											children: t("action.cancel")
										})
									]
								}) : row.kind === "mcp" ? (0, react_jsx_runtime.jsx)(McpConfigurationDraft, {
									options: configurationState.options,
									initial: configurationState.currentConfiguration,
									t,
									onSave: (configuration) => {
										launch(row, "configure", configuration, configurationState.returnFocus);
									},
									onDiscard: () => {
										setConfigurationState(void 0);
										configurationState.returnFocus.focus();
									}
								}) : (0, react_jsx_runtime.jsx)(SkillConfigurationDraft, {
									scopeKey: row.scopeKey,
									initial: configurationState.currentConfiguration,
									t,
									onSave: (configuration) => {
										launch(row, "configure", configuration, configurationState.returnFocus);
									},
									onDiscard: () => {
										setConfigurationState(void 0);
										configurationState.returnFocus.focus();
									}
								})
							]
						}, `${row.kind}:${row.targetKey}`))
					}),
					mutation === void 0 || management === void 0 ? null : (0, react_jsx_runtime.jsx)(MutationFlow, {
						request: mutation,
						candidate: candidates.get(mutation.candidateRef),
						management,
						t,
						onClose: () => {
							setMutation(void 0);
							setAttempt((value) => value + 1);
						},
						onCommitted: () => {
							setConfigurationState(void 0);
						}
					}, mutation.id)
				]
			});
		}
		/** Exact observed update targets; updates never apply automatically. */
		function UpdatesPanel({ management, context, candidates, t }) {
			const [attempt, setAttempt] = (0, react.useState)(0);
			const [scopeKey, setScopeKey] = (0, react.useState)(context.defaultScopeKey);
			const inventory = useInventory(management, context, scopeKey, attempt);
			const [mutation, setMutation] = (0, react.useState)();
			const [configurationError, setConfigurationError] = (0, react.useState)();
			const [loadingTarget, setLoadingTarget] = (0, react.useState)();
			if (inventory.status === "unavailable") return (0, react_jsx_runtime.jsx)(ManagementUnavailable, { t });
			if (inventory.status === "loading") return (0, react_jsx_runtime.jsx)("div", {
				className: ExtensionCenter_module_css_default.managementLoading,
				role: "status",
				children: t("updates.loading")
			});
			if (inventory.status === "error") return (0, react_jsx_runtime.jsx)(ManagementError, {
				error: inventory.error,
				t,
				onRetry: () => {
					setAttempt((value) => value + 1);
				}
			});
			const response = inventory.value;
			const writable = response.hostCapabilities.acquisition;
			const rows = response.inventory.rows.filter((row) => row.updateObservation.status === "available");
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ExtensionCenter_module_css_default.managementPanel,
				children: [
					(0, react_jsx_runtime.jsxs)("header", {
						className: ExtensionCenter_module_css_default.panelHeading,
						children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("h3", { children: t("updates.heading") }), (0, react_jsx_runtime.jsx)("p", { children: t("updates.body") })] }), (0, react_jsx_runtime.jsx)(ManagementScopePicker, {
							value: scopeKey,
							t,
							onChange: (value) => {
								setMutation(void 0);
								setConfigurationError(void 0);
								setScopeKey(value);
							}
						})]
					}),
					!writable ? (0, react_jsx_runtime.jsx)(ManagementUnavailable, {
						t,
						capabilities: response.hostCapabilities
					}) : null,
					configurationError === void 0 ? null : (0, react_jsx_runtime.jsx)("div", {
						className: ExtensionCenter_module_css_default.managementError,
						role: "alert",
						children: (0, react_jsx_runtime.jsx)("code", { children: configurationError })
					}),
					rows.length === 0 ? (0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.empty,
						children: [(0, react_jsx_runtime.jsx)("h3", { children: t("updates.empty") }), (0, react_jsx_runtime.jsx)("p", { children: t("updates.empty.body") })]
					}) : (0, react_jsx_runtime.jsx)("div", {
						className: ExtensionCenter_module_css_default.updateList,
						"aria-label": t("updates.list"),
						children: rows.map((row) => {
							if (row.updateObservation.status !== "available") return null;
							const update = row.updateObservation;
							const available = writable && row.actions.update.status === "available";
							return (0, react_jsx_runtime.jsxs)("article", {
								className: ExtensionCenter_module_css_default.updateCard,
								children: [
									(0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("span", { children: row.kind }), (0, react_jsx_runtime.jsx)("h4", { children: row.extensionId })] }), (0, react_jsx_runtime.jsxs)("code", { children: [
										row.managedRevision,
										" → ",
										update.revision
									] })] }),
									(0, react_jsx_runtime.jsxs)("dl", { children: [
										(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("updates.candidate") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: update.candidateRef }) })] }),
										(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("updates.exactTarget") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: update.revision }) })] }),
										(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("field.integrity") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: update.integrity }) })] })
									] }),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: !available || loadingTarget === row.targetKey,
										title: actionTitle(row, "update", t),
										onClick: (event) => {
											if (management === void 0) return;
											const returnFocus = event.currentTarget;
											setLoadingTarget(row.targetKey);
											setConfigurationError(void 0);
											management.configurationOptions({
												candidateRef: update.candidateRef,
												operationKind: "update",
												targetKey: row.targetKey,
												scopeKey: row.scopeKey,
												profileId: row.profileId
											}).then((response) => {
												setLoadingTarget(void 0);
												setMutation({
													id: `${row.targetKey}:update:${String(Date.now())}`,
													candidateRef: update.candidateRef,
													operationKind: "update",
													scopeKey: row.scopeKey,
													profileId: row.profileId,
													targetKey: row.targetKey,
													configuration: response.currentConfiguration ?? {},
													returnFocus
												});
											}).catch((cause) => {
												setLoadingTarget(void 0);
												setConfigurationError(message(cause));
											});
										},
										children: t("action.update")
									})
								]
							}, row.targetKey);
						})
					}),
					mutation === void 0 || management === void 0 ? null : (0, react_jsx_runtime.jsx)(MutationFlow, {
						request: mutation,
						candidate: candidates.get(mutation.candidateRef),
						management,
						t,
						onClose: () => {
							setMutation(void 0);
							setAttempt((value) => value + 1);
						}
					}, mutation.id)
				]
			});
		}
		/** Verified operation phases, receipts, and exact fenced recovery retry. */
		function ActivityPanel({ management, context, candidates, t }) {
			const [attempt, setAttempt] = (0, react.useState)(0);
			const [state, setState] = (0, react.useState)({ status: management === void 0 ? "unavailable" : "loading" });
			const [recovery, setRecovery] = (0, react.useState)();
			const [selectedApproval, setSelectedApproval] = (0, react.useState)();
			const [selectedConfiguration, setSelectedConfiguration] = (0, react.useState)();
			const [taskAction, setTaskAction] = (0, react.useState)();
			(0, react.useEffect)(() => {
				if (management === void 0) {
					setState({ status: "unavailable" });
					return;
				}
				const controller = new AbortController();
				setState({ status: "loading" });
				Promise.all([
					management.operations(controller.signal),
					management.receipts(controller.signal),
					management.inventory(context.defaultScopeKey, context.profileId, controller.signal),
					management.taskApprovals(controller.signal),
					management.taskAttempts(controller.signal)
				]).then(([operations, receipts, inventory, approvals, taskAttempts]) => {
					setState({
						status: "ready",
						operations,
						receipts,
						inventory,
						approvals,
						taskAttempts
					});
				}).catch((cause) => {
					if (!controller.signal.aborted) setState({
						status: "error",
						error: message(cause)
					});
				});
				return () => {
					controller.abort();
				};
			}, [
				attempt,
				context.defaultScopeKey,
				context.profileId,
				management
			]);
			if (state.status === "unavailable") return (0, react_jsx_runtime.jsx)(ManagementUnavailable, { t });
			if (state.status === "loading") return (0, react_jsx_runtime.jsx)("div", {
				className: ExtensionCenter_module_css_default.managementLoading,
				role: "status",
				children: t("activity.loading")
			});
			if (state.status === "error") return (0, react_jsx_runtime.jsx)(ManagementError, {
				error: state.error,
				t,
				onRetry: () => {
					setAttempt((value) => value + 1);
				}
			});
			const operations = state.operations.operations;
			const approvals = state.approvals.approvals;
			const configurations = state.approvals.configurations;
			const taskAttempts = state.taskAttempts.attempts;
			const derivedSources = new Set(taskAttempts.flatMap((task) => task.parentAttemptId === null ? [] : [task.parentAttemptId]));
			const approval = selectedApproval === void 0 ? void 0 : approvals.find((row) => row.state.plan.hash === selectedApproval);
			const configuration = selectedConfiguration === void 0 ? void 0 : configurations.find((row) => `${row.resolutionId}\u0000${row.candidateRef}` === selectedConfiguration);
			const receiptByOperation = new Map(state.receipts.receipts.map((stored) => [stored.operationId, stored]));
			const writable = state.inventory.hostCapabilities.acquisition;
			const recover = (operationId) => {
				if (management === void 0) return;
				const controller = new AbortController();
				setRecovery({
					operationId,
					status: "running"
				});
				management.recover(operationId, controller.signal).then(() => {
					setRecovery(void 0);
					setAttempt((value) => value + 1);
				}).catch((cause) => {
					if (!controller.signal.aborted) setRecovery({
						operationId,
						status: "error",
						error: message(cause)
					});
				});
			};
			const runTaskAction = (taskAttemptId, action) => {
				const controller = new AbortController();
				setTaskAction({
					taskAttemptId,
					status: "running"
				});
				action(controller.signal).then(() => {
					setTaskAction(void 0);
					setAttempt((value) => value + 1);
				}).catch((cause) => {
					if (!controller.signal.aborted) setTaskAction({
						taskAttemptId,
						status: "error",
						error: message(cause)
					});
				});
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ExtensionCenter_module_css_default.managementPanel,
				children: [
					(0, react_jsx_runtime.jsx)("header", {
						className: ExtensionCenter_module_css_default.panelHeading,
						children: (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("h3", { children: t("activity.heading") }), (0, react_jsx_runtime.jsx)("p", { children: t("activity.body") })] })
					}),
					!writable ? (0, react_jsx_runtime.jsx)(ManagementUnavailable, {
						t,
						capabilities: state.inventory.hostCapabilities
					}) : null,
					(0, react_jsx_runtime.jsxs)("section", {
						className: ExtensionCenter_module_css_default.updateList,
						"aria-labelledby": "extension-center-task-attempts-heading",
						children: [(0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsx)("h3", {
							id: "extension-center-task-attempts-heading",
							children: t("taskAttempt.heading")
						}), (0, react_jsx_runtime.jsx)("p", { children: t("taskAttempt.body") })] }), taskAttempts.length === 0 ? (0, react_jsx_runtime.jsx)("p", { children: t("taskAttempt.empty") }) : taskAttempts.map((task) => {
							const running = taskAction?.taskAttemptId === task.taskAttemptId && taskAction.status === "running";
							const actionError = taskAction?.taskAttemptId === task.taskAttemptId && taskAction.status === "error" ? taskAction.error : void 0;
							const derived = derivedSources.has(task.taskAttemptId);
							const retryContinuationCancellable = task.retryContinuation !== null && CANCELABLE_RETRY_CONTINUATION_STATES.has(task.retryContinuation.state);
							const cancellable = task.outcome === null || retryContinuationCancellable;
							return (0, react_jsx_runtime.jsxs)("article", {
								className: ExtensionCenter_module_css_default.updateCard,
								"data-task-outcome": task.outcome ?? "active",
								children: [
									(0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("span", { children: task.trigger }), (0, react_jsx_runtime.jsx)("h4", { children: t("taskAttempt.heading") })] }), (0, react_jsx_runtime.jsx)("code", { children: task.outcome ?? task.phase })] }),
									(0, react_jsx_runtime.jsxs)("p", { children: [
										t("taskAttempt.id"),
										" ",
										(0, react_jsx_runtime.jsx)("code", { children: task.taskAttemptId })
									] }),
									(0, react_jsx_runtime.jsxs)("p", { children: [
										t("taskAttempt.phase"),
										" ",
										(0, react_jsx_runtime.jsx)("code", { children: task.phase })
									] }),
									task.outcome === null ? (0, react_jsx_runtime.jsx)("p", { children: t("taskAttempt.active") }) : (0, react_jsx_runtime.jsxs)("p", { children: [
										t("taskAttempt.outcome"),
										" ",
										(0, react_jsx_runtime.jsx)("code", { children: task.outcome })
									] }),
									task.parentAttemptId === null ? null : (0, react_jsx_runtime.jsxs)("p", { children: [
										t("taskAttempt.parent"),
										" ",
										(0, react_jsx_runtime.jsx)("code", { children: task.parentAttemptId })
									] }),
									task.choice === null ? null : (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("p", { children: t("taskAttempt.choice") }), (0, react_jsx_runtime.jsx)("div", {
										className: ExtensionCenter_module_css_default.inlineActions,
										children: task.choice.candidateRefs.map((ref) => (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											disabled: !writable || running || derived,
											onClick: () => {
												runTaskAction(task.taskAttemptId, (signal) => management.selectTaskCandidate(task.taskAttemptId, ref, signal));
											},
											children: [
												t("taskAttempt.select"),
												" ",
												t("locale.code") === "zh" ? candidates.get(ref)?.displayName.zh ?? ref : candidates.get(ref)?.displayName.en ?? ref
											]
										}, ref))
									})] }),
									task.management === null ? null : (0, react_jsx_runtime.jsxs)("div", { children: [
										(0, react_jsx_runtime.jsxs)("p", { children: [
											t("taskAttempt.management"),
											" ",
											(0, react_jsx_runtime.jsx)("code", { children: task.management.action })
										] }),
										(0, react_jsx_runtime.jsxs)("p", { children: [
											t("taskAttempt.extensionRef"),
											" ",
											(0, react_jsx_runtime.jsx)("code", { children: task.management.extensionRef })
										] }),
										(0, react_jsx_runtime.jsx)("button", {
											type: "button",
											disabled: !writable || running || derived,
											onClick: () => {
												runTaskAction(task.taskAttemptId, (signal) => management.retryOriginalTask(task.taskAttemptId, signal));
											},
											children: t("taskAttempt.retryOriginal")
										})
									] }),
									task.acquisition === null ? null : (0, react_jsx_runtime.jsxs)("p", { children: [
										t("taskAttempt.candidate"),
										" ",
										(0, react_jsx_runtime.jsx)("code", { children: task.acquisition.candidateRef })
									] }),
									task.retryContinuation === null ? null : (0, react_jsx_runtime.jsxs)("p", {
										"data-retry-continuation-state": task.retryContinuation.state,
										children: [
											t("taskAttempt.retryContinuation"),
											" ",
											(0, react_jsx_runtime.jsx)("strong", { children: t(RETRY_CONTINUATION_KEYS[task.retryContinuation.state]) })
										]
									}),
									!cancellable ? null : (0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: !writable || running,
										onClick: () => {
											runTaskAction(task.taskAttemptId, (signal) => management.cancelTaskAttempt(task.taskAttemptId, signal));
										},
										children: t(retryContinuationCancellable ? "taskAttempt.cancelContinuation" : "taskAttempt.cancel")
									}),
									derived ? (0, react_jsx_runtime.jsx)("p", { children: t("taskAttempt.derived") }) : null,
									actionError === void 0 ? null : (0, react_jsx_runtime.jsx)("div", {
										className: ExtensionCenter_module_css_default.managementError,
										role: "alert",
										children: (0, react_jsx_runtime.jsx)("code", { children: actionError })
									})
								]
							}, task.taskAttemptId);
						})]
					}),
					(0, react_jsx_runtime.jsxs)("section", {
						className: ExtensionCenter_module_css_default.updateList,
						"aria-labelledby": "extension-center-task-configurations-heading",
						children: [
							(0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsx)("h3", {
								id: "extension-center-task-configurations-heading",
								children: t("approval.configuration.heading")
							}), (0, react_jsx_runtime.jsx)("p", { children: t("approval.configuration.body") })] }),
							configurations.length === 0 ? (0, react_jsx_runtime.jsx)("p", { children: t("approval.configuration.empty") }) : configurations.map((row) => (0, react_jsx_runtime.jsxs)("article", {
								className: ExtensionCenter_module_css_default.updateCard,
								children: [
									(0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("span", { children: row.extensionKind }), (0, react_jsx_runtime.jsx)("h4", { children: t("locale.code") === "zh" ? candidates.get(row.candidateRef)?.displayName.zh ?? row.candidateRef : candidates.get(row.candidateRef)?.displayName.en ?? row.candidateRef })] }), (0, react_jsx_runtime.jsx)("code", { children: t("approval.configuration.required") })] }),
									(0, react_jsx_runtime.jsx)("p", { children: (0, react_jsx_runtime.jsx)("code", { children: row.candidateRef }) }),
									(0, react_jsx_runtime.jsxs)("p", { children: [
										t("plan.scope"),
										" ",
										(0, react_jsx_runtime.jsxs)("code", { children: [
											row.scopeKey,
											" / ",
											row.profileId
										] })
									] }),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: !writable,
										onClick: () => {
											setSelectedConfiguration(`${row.resolutionId}\u0000${row.candidateRef}`);
										},
										children: t("approval.configuration.open")
									})
								]
							}, `${row.resolutionId}\u0000${row.candidateRef}`)),
							configuration === void 0 || management === void 0 ? null : (0, react_jsx_runtime.jsx)(TaskConfigurationFlow, {
								row: configuration,
								management,
								t,
								onClose: () => {
									setSelectedConfiguration(void 0);
								},
								onCreated: (planHash) => {
									setSelectedConfiguration(void 0);
									setSelectedApproval(planHash);
									setAttempt((value) => value + 1);
								}
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("section", {
						className: ExtensionCenter_module_css_default.updateList,
						"aria-labelledby": "extension-center-task-approvals-heading",
						children: [
							(0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsx)("h3", {
								id: "extension-center-task-approvals-heading",
								children: t("approval.heading")
							}), (0, react_jsx_runtime.jsx)("p", { children: t("approval.body") })] }),
							approvals.length === 0 ? (0, react_jsx_runtime.jsx)("p", { children: t("approval.empty") }) : approvals.map((row) => (0, react_jsx_runtime.jsxs)("article", {
								className: ExtensionCenter_module_css_default.updateCard,
								children: [
									(0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("span", { children: row.state.status }), (0, react_jsx_runtime.jsx)("h4", { children: row.state.plan.content.extensionId })] }), (0, react_jsx_runtime.jsx)("code", { children: row.state.plan.content.operationKind })] }),
									(0, react_jsx_runtime.jsx)("p", { children: (0, react_jsx_runtime.jsx)("code", { children: row.state.plan.content.candidateRef }) }),
									(0, react_jsx_runtime.jsxs)("p", { children: [
										t("plan.scope"),
										" ",
										(0, react_jsx_runtime.jsxs)("code", { children: [
											row.state.plan.content.scopeKey,
											" / ",
											row.state.plan.content.profileId
										] })
									] }),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										disabled: !writable,
										onClick: () => {
											setSelectedApproval(row.state.plan.hash);
										},
										children: t("approval.review")
									})
								]
							}, row.state.plan.hash)),
							approval === void 0 || management === void 0 ? null : (0, react_jsx_runtime.jsx)(PlanReview, {
								preview: {
									protocolVersion: 1,
									intentId: approval.state.plan.content.intentId,
									plan: approval.state.plan,
									policy: {
										status: "eligible",
										policyRevision: "extension-center-p0-policy-v2",
										authorityDigest: approval.state.plan.content.authorityDigest
									}
								},
								candidate: candidates.get(approval.state.plan.content.candidateRef),
								management,
								configuration: approval.configuration,
								initialState: approval.state,
								t,
								onClose: () => {
									setSelectedApproval(void 0);
									setAttempt((value) => value + 1);
								},
								onCommitted: () => {
									setSelectedApproval(void 0);
									setAttempt((value) => value + 1);
								}
							})
						]
					}),
					operations.length === 0 ? (0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.empty,
						children: [(0, react_jsx_runtime.jsx)("h3", { children: t("activity.empty") }), (0, react_jsx_runtime.jsx)("p", { children: t("activity.empty.body") })]
					}) : (0, react_jsx_runtime.jsx)("ol", {
						className: ExtensionCenter_module_css_default.activityList,
						"aria-label": t("activity.list"),
						children: operations.map((operation) => {
							const stored = receiptByOperation.get(operation.operationId);
							const recovering = recovery?.operationId === operation.operationId && recovery.status === "running";
							const recoveryError = recovery?.operationId === operation.operationId && recovery.status === "error" ? recovery.error : void 0;
							return (0, react_jsx_runtime.jsx)("li", {
								"data-operation-phase": operation.phase,
								children: (0, react_jsx_runtime.jsxs)("article", {
									className: ExtensionCenter_module_css_default.activityCard,
									children: [
										(0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("span", { children: operation.operationKind }), (0, react_jsx_runtime.jsx)("h4", { children: operation.targetKey })] }), (0, react_jsx_runtime.jsx)("code", { children: operation.phase })] }),
										(0, react_jsx_runtime.jsxs)("p", { children: [
											t("operation.id"),
											" ",
											(0, react_jsx_runtime.jsx)("code", { children: operation.operationId })
										] }),
										(0, react_jsx_runtime.jsxs)("p", { children: [
											t("operation.updated"),
											" ",
											(0, react_jsx_runtime.jsx)("time", {
												dateTime: new Date(operation.lastAtMs).toISOString(),
												children: new Date(operation.lastAtMs).toLocaleString()
											})
										] }),
										stored === void 0 ? (0, react_jsx_runtime.jsx)("p", { children: t("receipt.pending") }) : (0, react_jsx_runtime.jsxs)("dl", { children: [
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.outcome") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.outcome }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.source") }), (0, react_jsx_runtime.jsxs)("dd", { children: [
												(0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.planEvidence.candidateRef }),
												" · ",
												(0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.planEvidence.artifactUrl })
											] })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.version") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.planEvidence.artifactRevision }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.integrity") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.planEvidence.artifactIntegrity }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.scope") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsxs)("code", { children: [
												stored.receipt.body.planEvidence.scopeKey,
												" / ",
												stored.receipt.body.planEvidence.profileId
											] }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.configuration") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.planEvidence.configurationDigest }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.authority") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.planEvidence.authorityDigest }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.retention") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.planEvidence.retentionDigest }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.mutation") }), (0, react_jsx_runtime.jsxs)("dd", { children: [
												(0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.evidence.mutation }),
												" · ",
												(0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.planEvidence.mutationDigest })
											] })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.verification") }), (0, react_jsx_runtime.jsxs)("dd", { children: [
												(0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.evidence.verification }),
												" · ",
												(0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.planEvidence.verificationDigest })
											] })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.rollback") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.evidence.rollback.status }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.restart") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.evidence.restart.status }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.recovery") }), (0, react_jsx_runtime.jsxs)("dd", { children: [
												(0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.evidence.recovery.status }),
												" · ",
												stored.receipt.body.evidence.recovery.attempts
											] })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("review.checksRun") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.evidence.checksActuallyRun.map((item) => `${item.phase}:${item.code}`).join(", ") }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.notProven") }), (0, react_jsx_runtime.jsx)("dd", { children: stored.receipt.body.evidence.notProven.length === 0 ? t("field.none") : (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.evidence.notProven.join(", ") }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.managedObject") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.managedObject }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.externalRuntimeAction") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.externalRuntimeAction }) })] }),
											stored.receipt.body.runtimeBinding === null ? null : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
												(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.runtimeRef") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.runtimeBinding.runtimeRef }) })] }),
												(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.runtimeVersion") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.runtimeBinding.version }) })] }),
												(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("plan.runtimeDescriptorDigest") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.runtimeBinding.descriptorDigest }) })] })
											] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.digest") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: stored.receipt.digest }) })] }),
											(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("receipt.journal") }), (0, react_jsx_runtime.jsxs)("dd", { children: [
												stored.receipt.body.journalEventCount,
												" · ",
												(0, react_jsx_runtime.jsx)("code", { children: stored.receipt.body.journalHeadDigest })
											] })] })
										] }),
										stored === void 0 ? null : (0, react_jsx_runtime.jsx)(ReviewEvidenceDetails, {
											evidence: stored.receipt.body.planEvidence.reviewEvidence,
											t
										}),
										operation.phase !== "recovery-required" && operation.recoveryNotice !== "retired-runtime-quarantined" ? null : (0, react_jsx_runtime.jsxs)("div", {
											className: ExtensionCenter_module_css_default.recoveryCallout,
											role: "alert",
											children: [
												(0, react_jsx_runtime.jsx)("strong", { children: t("recovery.required") }),
												(0, react_jsx_runtime.jsx)("p", { children: operation.recoveryNotice === "retired-runtime-quarantined" ? t("recovery.retiredRuntime") : t("recovery.required.body") }),
												operation.recoveryCommand === null ? null : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
													(0, react_jsx_runtime.jsx)("p", { children: t("recovery.command") }),
													(0, react_jsx_runtime.jsx)("pre", { children: JSON.stringify(operation.recoveryCommand) }),
													(0, react_jsx_runtime.jsx)("p", { children: t("recovery.reconciliationPending") })
												] }),
												recoveryError === void 0 ? null : (0, react_jsx_runtime.jsx)("code", { children: recoveryError }),
												operation.recoveryNotice === "retired-runtime-quarantined" ? null : (0, react_jsx_runtime.jsx)("button", {
													type: "button",
													disabled: !writable || recovering,
													onClick: () => {
														recover(operation.operationId);
													},
													children: recovering ? t("recovery.running") : t("action.recover")
												})
											]
										})
									]
								})
							}, operation.operationId);
						})
					})
				]
			});
		}
		//#endregion
		//#region lib/.build/client/StorePanel.js
		const LIFECYCLE_ACTIONS = [
			["install", "field.lifecycle.install"],
			["configure", "field.lifecycle.configure"],
			["update", "field.lifecycle.update"],
			["uninstall", "field.lifecycle.uninstall"],
			["restore", "field.lifecycle.restore"]
		];
		function localize(value, language) {
			return value[language];
		}
		function lifecycleComplete(entry) {
			return Object.values(entry.lifecycle).every((action) => action.status === "available");
		}
		function writableScope(entry, scope) {
			return entry.scopes.includes(scope) && !(entry.kind === "skill" && scope === "project");
		}
		function scopeOption(entry, scope, t) {
			if (entry.kind === "skill" && scope === "project") return t("scope.projectUnavailable");
			return t(`scope.${scope === "profile:web" ? "profile" : scope}`);
		}
		function licenseLabel(entry, t) {
			const status = entry.license.status === "publisher-declared" ? "declared" : entry.license.status;
			return `${entry.license.spdx ?? t("license.unknown")} · ${t(`license.${status}`)}`;
		}
		function admissionLabel(entry, t) {
			return t(`publisher.${entry.publisher.status === "upstream-registry" ? "registry" : "community"}`);
		}
		function permissionLabel(entry, phase, language, t) {
			const labels = entry.permissions.filter((permission) => permission.phase === phase && permission.access !== "none").map((permission) => {
				return `${t(`permission.${permission.kind === "model-context" ? "model" : permission.kind}`)} (${permission.access}): ${localize(permission.detail, language)}`;
			});
			return [...new Set(labels)].join(", ") || t("field.none");
		}
		function verificationLabel(entry, language, t) {
			return entry.verification.map((claim) => `${localize(claim.claim, language)} · ${t(`verification.${claim.status}`)}: ${localize(claim.detail, language)}`).join("; ") || t("field.notDeclared");
		}
		function sourceLabel(entry) {
			return `${entry.source.label} · ${entry.source.type} · ${entry.source.upstreamUrl} · ${entry.source.admittedAt}`;
		}
		function artifactLabel(entry) {
			return `${entry.artifact.id}@${entry.artifact.version} · ${entry.artifact.sizeBytes} bytes · ${entry.artifact.acquisitionUrl}`;
		}
		function compatibilityLabel(entry, language, t) {
			return `${entry.compatibility.status === "compatible" ? t("compatibility.compatible") : t("compatibility.review")} · DSH ${entry.compatibility.dsh} · ${entry.compatibility.platforms.join("/")} · ${localize(entry.compatibility.detail, language)}`;
		}
		function dependencyLabel(entry, t) {
			return entry.dependencies.map((dependency) => {
				const requirement = dependency.required ? t("dependency.required") : t("dependency.optional");
				return `${t(`dependency.${dependency.kind}`)} · ${dependency.id} ${dependency.version} · ${requirement}`;
			}).join("; ") || t("field.notDeclared");
		}
		function configurationLabel(entry, language, t) {
			const requirement = entry.configuration.required ? t("configuration.required") : t("configuration.ready");
			const credentials = t(`credentials.${entry.configuration.credentials}`);
			const fields = entry.configuration.fields.map((field) => localize(field, language)).join("; ") || t("field.notDeclared");
			return `${requirement} · ${t("field.credentials")}: ${credentials} · ${fields}`;
		}
		function lifecycleActionLabel(entry, action, t, unavailableReason) {
			if (unavailableReason !== void 0) return `${t("lifecycle.unavailable")} · ${unavailableReason}`;
			const availability = entry.lifecycle[action];
			const status = t(`lifecycle.${availability.status}`);
			if (availability.reason === void 0) return availability.status === "available" ? status : `${status} · ${t("field.notDeclared")}`;
			return `${status} · ${availability.status}(${availability.reason})`;
		}
		function revealRegion(id) {
			const region = document.getElementById(id);
			region?.focus();
			region?.scrollIntoView?.({ block: "start" });
		}
		function visibleEntries(snapshot, language, query, kind, scope, configuration, permission, lifecycle, writable, mcpAvailability) {
			const needle = query.trim().toLocaleLowerCase(language === "zh" ? "zh-CN" : "en-US");
			return snapshot.entries.filter((entry) => {
				const lifecycleAvailable = writable && (entry.kind !== "mcp" || mcpAvailability[entry.candidateRef] === "ready") && lifecycleComplete(entry);
				if (kind !== "all" && entry.kind !== kind) return false;
				if (scope !== "all" && !entry.scopes.includes(scope)) return false;
				if (configuration === "ready" && entry.configuration.required) return false;
				if (configuration === "required" && !entry.configuration.required) return false;
				if (permission !== "all" && !entry.permissions.some((item) => item.kind === permission && item.access !== "none")) return false;
				if (lifecycle === "complete" && !lifecycleAvailable) return false;
				if (lifecycle === "blocked" && lifecycleAvailable) return false;
				if (needle === "") return true;
				return [
					entry.name,
					entry.displayName.en,
					entry.displayName.zh,
					entry.summary.en,
					entry.summary.zh,
					entry.publisher.name,
					entry.kind,
					...entry.tags
				].join("\n").toLocaleLowerCase(language === "zh" ? "zh-CN" : "en-US").includes(needle);
			}).sort((left, right) => {
				const name = localize(left.displayName, language).localeCompare(localize(right.displayName, language), language === "zh" ? "zh-CN" : "en-US");
				return name === 0 ? left.candidateRef.localeCompare(right.candidateRef) : name;
			});
		}
		/** Signed offline Store with local search, filters, details, and bounded comparison. */
		function StorePanel({ catalog, management, context, t }) {
			const language = t("locale.code") === "zh" ? "zh" : "en";
			const [snapshot, setSnapshot] = (0, react.useState)();
			const [error, setError] = (0, react.useState)();
			const [refreshing, setRefreshing] = (0, react.useState)(false);
			const [attempt, setAttempt] = (0, react.useState)(0);
			const [query, setQuery] = (0, react.useState)("");
			const [kind, setKind] = (0, react.useState)("all");
			const [scope, setScope] = (0, react.useState)("all");
			const [configuration, setConfiguration] = (0, react.useState)("all");
			const [permission, setPermission] = (0, react.useState)("all");
			const [lifecycle, setLifecycle] = (0, react.useState)("all");
			const [detailRef, setDetailRef] = (0, react.useState)();
			const [compareRefs, setCompareRefs] = (0, react.useState)([]);
			const [comparisonOpen, setComparisonOpen] = (0, react.useState)(false);
			const [managementAttempt, setManagementAttempt] = (0, react.useState)(0);
			const [managementState, setManagementState] = (0, react.useState)({ status: management === void 0 ? "unavailable" : "loading" });
			const [selectedScopes, setSelectedScopes] = (0, react.useState)({});
			const [mcpAvailability, setMcpAvailability] = (0, react.useState)({});
			const [mutation, setMutation] = (0, react.useState)();
			const [typedDraft, setTypedDraft] = (0, react.useState)();
			const configurationRequest = (0, react.useRef)();
			const catalogRefreshRequest = (0, react.useRef)();
			const comparisonTrigger = (0, react.useRef)(null);
			const detailTrigger = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const controller = new AbortController();
				setSnapshot(void 0);
				setError(void 0);
				catalog.list(controller.signal).then(setSnapshot).catch((cause) => {
					if (controller.signal.aborted) return;
					setError(cause instanceof Error ? cause.message : String(cause));
				});
				return () => {
					controller.abort();
				};
			}, [attempt, catalog]);
			(0, react.useEffect)(() => {
				if (management === void 0) {
					setManagementState({ status: "unavailable" });
					return;
				}
				const controller = new AbortController();
				setManagementState({ status: "loading" });
				management.inventory(context.defaultScopeKey, context.profileId, controller.signal).then((response) => {
					setManagementState({
						status: "ready",
						acquisition: response.hostCapabilities.acquisition,
						capabilities: response.hostCapabilities
					});
				}).catch((cause) => {
					if (!controller.signal.aborted) setManagementState({
						status: "error",
						error: cause instanceof Error ? cause.message : String(cause)
					});
				});
				return () => {
					controller.abort();
				};
			}, [
				context.defaultScopeKey,
				context.profileId,
				management,
				managementAttempt
			]);
			(0, react.useEffect)(() => () => {
				configurationRequest.current?.abort();
				catalogRefreshRequest.current?.abort();
			}, []);
			(0, react.useEffect)(() => {
				if (management === void 0 || snapshot === void 0 || managementState.status !== "ready") return;
				const controller = new AbortController();
				const entries = snapshot.entries.filter((entry) => entry.kind === "mcp");
				setMcpAvailability(Object.fromEntries(entries.map((entry) => [entry.candidateRef, "loading"])));
				for (const entry of entries) {
					const scopeKey = entry.scopes[0];
					if (scopeKey === void 0) continue;
					management.configurationOptions({
						candidateRef: entry.candidateRef,
						operationKind: "install",
						targetKey: null,
						scopeKey,
						profileId: context.profileId
					}, controller.signal).then((response) => {
						if (!controller.signal.aborted) setMcpAvailability((current) => ({
							...current,
							[entry.candidateRef]: response.options.length === 0 ? "missing" : "ready"
						}));
					}).catch(() => {
						if (!controller.signal.aborted) setMcpAvailability((current) => ({
							...current,
							[entry.candidateRef]: "error"
						}));
					});
				}
				return () => {
					controller.abort();
				};
			}, [
				context.profileId,
				management,
				managementState.status,
				snapshot
			]);
			(0, react.useEffect)(() => {
				if (detailRef !== void 0) revealRegion("extension-center-detail");
			}, [detailRef]);
			(0, react.useEffect)(() => {
				if (comparisonOpen && compareRefs.length >= 2) revealRegion("extension-center-comparison");
			}, [compareRefs.length, comparisonOpen]);
			const writable = snapshot !== void 0 && snapshot.hostCapabilities.acquisition && managementState.status === "ready" && managementState.acquisition === true;
			const results = (0, react.useMemo)(() => snapshot === void 0 ? [] : visibleEntries(snapshot, language, query, kind, scope, configuration, permission, lifecycle, writable, mcpAvailability), [
				configuration,
				kind,
				language,
				lifecycle,
				mcpAvailability,
				permission,
				query,
				scope,
				snapshot,
				writable
			]);
			const byRef = (0, react.useMemo)(() => new Map(snapshot?.entries.map((entry) => [entry.candidateRef, entry]) ?? []), [snapshot]);
			const detail = detailRef === void 0 ? void 0 : byRef.get(detailRef);
			const compared = compareRefs.flatMap((ref) => {
				const entry = byRef.get(ref);
				return entry === void 0 ? [] : [entry];
			});
			const unavailableReason = (entry) => !writable ? t("lifecycle.code") : entry.kind === "mcp" && mcpAvailability[entry.candidateRef] !== "ready" ? t("mcpConfig.runtimeMissing") : void 0;
			const launchStoreMutation = (entry, operationKind, configuration, returnFocus) => {
				const selectedScope = selectedScopes[entry.candidateRef];
				if (!writable || selectedScope === void 0 || !writableScope(entry, selectedScope)) return;
				if (entry.lifecycle[operationKind].status !== "available") return;
				setMutation({
					id: `${entry.candidateRef}:${operationKind}:${selectedScope}:${String(Date.now())}`,
					candidate: entry,
					candidateRef: entry.candidateRef,
					operationKind,
					scopeKey: selectedScope,
					profileId: context.profileId,
					targetKey: null,
					configuration,
					returnFocus
				});
			};
			const openTypedDraft = (entry, operationKind, returnFocus) => {
				const selectedScope = selectedScopes[entry.candidateRef];
				if (management === void 0 || selectedScope === void 0 || !writableScope(entry, selectedScope)) return;
				configurationRequest.current?.abort();
				const controller = new AbortController();
				configurationRequest.current = controller;
				setTypedDraft({
					entry,
					operationKind,
					scopeKey: selectedScope,
					returnFocus,
					status: "loading",
					options: [],
					currentConfiguration: null
				});
				management.configurationOptions({
					candidateRef: entry.candidateRef,
					operationKind,
					targetKey: null,
					scopeKey: selectedScope,
					profileId: context.profileId
				}, controller.signal).then((response) => {
					if (!controller.signal.aborted) setTypedDraft({
						entry,
						operationKind,
						scopeKey: selectedScope,
						returnFocus,
						status: "ready",
						options: response.options,
						currentConfiguration: response.currentConfiguration
					});
				}).catch((cause) => {
					if (!controller.signal.aborted) setTypedDraft({
						entry,
						operationKind,
						scopeKey: selectedScope,
						returnFocus,
						status: "error",
						options: [],
						currentConfiguration: null,
						error: cause instanceof Error ? cause.message : String(cause)
					});
				});
			};
			const toggleCompare = (candidateRef) => {
				setCompareRefs((current) => current.includes(candidateRef) ? current.filter((ref) => ref !== candidateRef) : current.length >= 3 ? current : [...current, candidateRef]);
			};
			if (error !== void 0) return (0, react_jsx_runtime.jsxs)("section", {
				className: ExtensionCenter_module_css_default.discoveryError,
				role: "alert",
				children: [
					(0, react_jsx_runtime.jsx)("strong", { children: t("catalog.unavailable") }),
					(0, react_jsx_runtime.jsx)("p", { children: t("catalog.unavailable.body") }),
					(0, react_jsx_runtime.jsx)("code", { children: error }),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => {
							setAttempt((value) => value + 1);
						},
						children: t("catalog.retry")
					})
				]
			});
			if (snapshot === void 0) return (0, react_jsx_runtime.jsx)("div", {
				className: ExtensionCenter_module_css_default.catalogLoading,
				role: "status",
				children: t("catalog.loading")
			});
			return (0, react_jsx_runtime.jsxs)("div", {
				className: ExtensionCenter_module_css_default.store,
				children: [
					(0, react_jsx_runtime.jsxs)("section", {
						className: ExtensionCenter_module_css_default.catalogStatus,
						"aria-label": t("catalog.status"),
						"data-catalog-revision": snapshot.catalog.revision,
						"data-catalog-signature": snapshot.catalog.signatureStatus,
						"data-catalog-source": snapshot.catalog.source,
						"data-catalog-freshness": snapshot.catalog.freshness,
						"data-catalog-degraded": String(snapshot.catalog.degraded),
						children: [
							(0, react_jsx_runtime.jsxs)("div", { children: [
								(0, react_jsx_runtime.jsx)("strong", { children: t("catalog.verified") }),
								(0, react_jsx_runtime.jsxs)("span", { children: [
									t("catalog.revision"),
									" ",
									snapshot.catalog.revision
								] }),
								(0, react_jsx_runtime.jsxs)("span", { children: [
									snapshot.entries.length,
									" ",
									t("catalog.candidates")
								] }),
								(0, react_jsx_runtime.jsxs)("span", { children: [
									t("catalog.source"),
									": ",
									snapshot.catalog.source
								] }),
								(0, react_jsx_runtime.jsxs)("span", { children: [
									t("catalog.freshness"),
									": ",
									snapshot.catalog.freshness
								] })
							] }),
							(0, react_jsx_runtime.jsxs)("code", {
								"data-catalog-digest": snapshot.catalog.entriesDigest,
								title: snapshot.catalog.entriesDigest,
								children: [snapshot.catalog.entriesDigest.slice(0, 22), "…"]
							}),
							snapshot.catalog.lastRefreshAtMs === null ? null : (0, react_jsx_runtime.jsxs)("span", { children: [
								t("catalog.lastRefresh"),
								": ",
								new Date(snapshot.catalog.lastRefreshAtMs).toLocaleString(language === "zh" ? "zh-CN" : "en-US")
							] }),
							snapshot.catalog.degraded ? (0, react_jsx_runtime.jsxs)("p", {
								role: "status",
								children: [
									(0, react_jsx_runtime.jsx)("strong", { children: t("catalog.degraded") }),
									": ",
									snapshot.catalog.degradedReason
								]
							}) : null,
							(0, react_jsx_runtime.jsx)("p", { children: t("catalog.offline") }),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: refreshing,
								onClick: () => {
									if (catalog.refresh === void 0) {
										setAttempt((value) => value + 1);
										return;
									}
									catalogRefreshRequest.current?.abort();
									const controller = new AbortController();
									catalogRefreshRequest.current = controller;
									setRefreshing(true);
									setError(void 0);
									catalog.refresh(controller.signal).then((value) => {
										if (!controller.signal.aborted) setSnapshot(value);
									}).catch((cause) => {
										if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
									}).finally(() => {
										if (!controller.signal.aborted) setRefreshing(false);
									});
								},
								children: refreshing ? t("catalog.loading") : t("catalog.refresh")
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("section", {
						className: ExtensionCenter_module_css_default.discoveryControls,
						"aria-labelledby": "extension-center-discovery-heading",
						children: [
							(0, react_jsx_runtime.jsxs)("div", {
								className: ExtensionCenter_module_css_default.discoveryHeading,
								children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("h3", {
									id: "extension-center-discovery-heading",
									children: t("store.heading")
								}), (0, react_jsx_runtime.jsx)("p", { children: t("store.body") })] }), (0, react_jsx_runtime.jsxs)("button", {
									ref: comparisonTrigger,
									type: "button",
									disabled: compareRefs.length < 2,
									"aria-expanded": comparisonOpen && compared.length >= 2,
									"aria-controls": "extension-center-comparison",
									onClick: () => {
										setDetailRef(void 0);
										setComparisonOpen(true);
									},
									children: [
										t("compare.open"),
										" (",
										compareRefs.length,
										"/3)"
									]
								})]
							}),
							(0, react_jsx_runtime.jsxs)("label", {
								className: ExtensionCenter_module_css_default.search,
								children: [(0, react_jsx_runtime.jsx)("span", { children: t("search.label") }), (0, react_jsx_runtime.jsx)("input", {
									type: "search",
									value: query,
									placeholder: t("search.placeholder"),
									onChange: (event) => {
										setQuery(event.currentTarget.value);
									}
								})]
							}),
							(0, react_jsx_runtime.jsxs)("div", {
								className: ExtensionCenter_module_css_default.filters,
								children: [
									(0, react_jsx_runtime.jsx)(Filter, {
										label: t("filter.kind"),
										value: kind,
										onChange: (value) => {
											setKind(value);
										},
										options: [
											["all", t("filter.all")],
											["plugin", t("kind.plugin")],
											["mcp", t("kind.mcp")],
											["skill", t("kind.skill")]
										]
									}),
									(0, react_jsx_runtime.jsx)(Filter, {
										label: t("filter.scope"),
										value: scope,
										onChange: (value) => {
											setScope(value);
										},
										options: [
											["all", t("filter.all")],
											["profile:web", t("scope.profile")],
											["user", t("scope.user")],
											["project", t("scope.project")]
										]
									}),
									(0, react_jsx_runtime.jsx)(Filter, {
										label: t("filter.configuration"),
										value: configuration,
										onChange: (value) => {
											setConfiguration(value);
										},
										options: [
											["all", t("filter.all")],
											["ready", t("configuration.ready")],
											["required", t("configuration.required")]
										]
									}),
									(0, react_jsx_runtime.jsx)(Filter, {
										label: t("filter.permission"),
										value: permission,
										onChange: (value) => {
											setPermission(value);
										},
										options: [
											["all", t("filter.all")],
											["network", t("permission.network")],
											["filesystem", t("permission.filesystem")],
											["subprocess", t("permission.subprocess")],
											["credentials", t("permission.credentials")],
											["model-context", t("permission.model")]
										]
									}),
									(0, react_jsx_runtime.jsx)(Filter, {
										label: t("filter.lifecycle"),
										value: lifecycle,
										onChange: (value) => {
											setLifecycle(value);
										},
										options: [
											["all", t("filter.all")],
											["complete", t("lifecycle.complete")],
											["blocked", t("lifecycle.blocked")]
										]
									})
								]
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.resultSummary,
						role: "status",
						children: [
							t("results.showing"),
							" ",
							results.length,
							" / ",
							snapshot.entries.length
						]
					}),
					results.length === 0 ? (0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.empty,
						children: [(0, react_jsx_runtime.jsx)("h3", { children: t("results.empty") }), (0, react_jsx_runtime.jsx)("p", { children: t("results.empty.body") })]
					}) : (0, react_jsx_runtime.jsx)("div", {
						className: ExtensionCenter_module_css_default.candidateGrid,
						"aria-label": t("results.label"),
						children: results.map((entry) => (0, react_jsx_runtime.jsx)(CandidateCard, {
							entry,
							language,
							detailOpen: detailRef === entry.candidateRef,
							selected: compareRefs.includes(entry.candidateRef),
							compareDisabled: compareRefs.length >= 3 && !compareRefs.includes(entry.candidateRef),
							selectedScope: selectedScopes[entry.candidateRef] ?? "",
							writable: writable && (entry.kind !== "mcp" || mcpAvailability[entry.candidateRef] === "ready"),
							acquisitionReason: unavailableReason(entry),
							t,
							onDetails: (origin) => {
								detailTrigger.current = origin;
								setDetailRef(entry.candidateRef);
								setComparisonOpen(false);
							},
							onCompare: () => {
								toggleCompare(entry.candidateRef);
							},
							onScope: (selectedScope) => {
								setSelectedScopes((current) => ({
									...current,
									[entry.candidateRef]: selectedScope
								}));
							},
							onAcquire: (returnFocus) => {
								const selectedScope = selectedScopes[entry.candidateRef];
								if (selectedScope === void 0 || selectedScope === "") return;
								setDetailRef(void 0);
								setComparisonOpen(false);
								if (entry.kind === "skill" || entry.kind === "mcp") openTypedDraft(entry, "install", returnFocus);
								else launchStoreMutation(entry, "install", {}, returnFocus);
							}
						}, entry.candidateRef))
					}),
					detail === void 0 ? null : (0, react_jsx_runtime.jsx)(CandidateDetail, {
						entry: detail,
						language,
						writable: writable && (detail.kind !== "mcp" || mcpAvailability[detail.candidateRef] === "ready"),
						unavailableReason: unavailableReason(detail),
						selectedScope: selectedScopes[detail.candidateRef] ?? "",
						t,
						onScope: (selectedScope) => {
							setSelectedScopes((current) => ({
								...current,
								[detail.candidateRef]: selectedScope
							}));
						},
						onLifecycle: (operationKind, configuration, returnFocus) => {
							if ((detail.kind === "skill" || detail.kind === "mcp") && (operationKind === "install" || operationKind === "configure")) openTypedDraft(detail, operationKind, returnFocus);
							else launchStoreMutation(detail, operationKind, configuration, returnFocus);
						},
						onClose: () => {
							setDetailRef(void 0);
							detailTrigger.current?.focus();
						}
					}),
					!comparisonOpen || compared.length < 2 ? null : (0, react_jsx_runtime.jsx)(Comparison, {
						entries: compared,
						language,
						t,
						unavailableReason,
						onClose: () => {
							setComparisonOpen(false);
							comparisonTrigger.current?.focus();
						}
					}),
					mutation === void 0 || management === void 0 ? null : (0, react_jsx_runtime.jsx)(MutationFlow, {
						request: mutation,
						candidate: mutation.candidate,
						management,
						t,
						onClose: () => {
							setMutation(void 0);
							setManagementAttempt((value) => value + 1);
						}
					}, mutation.id),
					typedDraft === void 0 ? null : (0, react_jsx_runtime.jsxs)("section", {
						className: ExtensionCenter_module_css_default.planReview,
						"aria-label": t("field.configuration"),
						tabIndex: -1,
						children: [
							typedDraft.status === "loading" ? (0, react_jsx_runtime.jsx)("div", {
								role: "status",
								children: t("inventory.loading")
							}) : null,
							typedDraft.status === "error" ? (0, react_jsx_runtime.jsxs)("div", {
								className: ExtensionCenter_module_css_default.managementError,
								role: "alert",
								children: [
									(0, react_jsx_runtime.jsx)("strong", { children: t("management.unavailable") }),
									(0, react_jsx_runtime.jsx)("code", { children: typedDraft.error }),
									(0, react_jsx_runtime.jsx)("button", {
										type: "button",
										onClick: () => {
											setTypedDraft(void 0);
											typedDraft.returnFocus.focus();
										},
										children: t("action.cancel")
									})
								]
							}) : null,
							typedDraft.status !== "ready" ? null : typedDraft.entry.kind === "mcp" ? (0, react_jsx_runtime.jsx)(McpConfigurationDraft, {
								options: typedDraft.options,
								initial: typedDraft.currentConfiguration,
								t,
								onSave: (value) => {
									const current = typedDraft;
									setTypedDraft(void 0);
									launchStoreMutation(current.entry, current.operationKind, value, current.returnFocus);
								},
								onDiscard: () => {
									setTypedDraft(void 0);
									typedDraft.returnFocus.focus();
								}
							}) : (0, react_jsx_runtime.jsx)(SkillConfigurationDraft, {
								scopeKey: typedDraft.scopeKey,
								initial: typedDraft.currentConfiguration,
								t,
								onSave: (value) => {
									const current = typedDraft;
									setTypedDraft(void 0);
									launchStoreMutation(current.entry, current.operationKind, value, current.returnFocus);
								},
								onDiscard: () => {
									setTypedDraft(void 0);
									typedDraft.returnFocus.focus();
								}
							})
						]
					}),
					snapshot.hostCapabilities.acquisition && managementState.status === "ready" && managementState.acquisition === true ? null : (0, react_jsx_runtime.jsx)(LifecycleUnavailable, {
						t,
						capabilities: managementState.status === "ready" && managementState.acquisition === false ? managementState.capabilities ?? snapshot.hostCapabilities : snapshot.hostCapabilities,
						error: managementState.error,
						retry: management === void 0 ? void 0 : () => {
							setManagementAttempt((value) => value + 1);
						}
					})
				]
			});
		}
		function Filter({ label, value, options, onChange }) {
			return (0, react_jsx_runtime.jsxs)("label", { children: [(0, react_jsx_runtime.jsx)("span", { children: label }), (0, react_jsx_runtime.jsx)("select", {
				value,
				onChange: (event) => {
					onChange(event.currentTarget.value);
				},
				children: options.map(([option, copy]) => (0, react_jsx_runtime.jsx)("option", {
					value: option,
					children: copy
				}, option))
			})] });
		}
		function CandidateCard({ entry, language, detailOpen, selected, compareDisabled, selectedScope, writable, t, acquisitionReason, onDetails, onCompare, onScope, onAcquire }) {
			const permissions = [...new Set(entry.permissions.filter((item) => item.access !== "none").map((item) => t(`permission.${item.kind === "model-context" ? "model" : item.kind}`)))];
			const admitted = entry.lifecycle.install.status === "available";
			const acquireAvailable = writable && admitted;
			return (0, react_jsx_runtime.jsxs)("article", {
				className: ExtensionCenter_module_css_default.candidateCard,
				"data-candidate-ref": entry.candidateRef,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.cardMeta,
						children: [(0, react_jsx_runtime.jsx)("span", {
							"data-kind": entry.kind,
							children: t(`kind.${entry.kind}`)
						}), (0, react_jsx_runtime.jsx)("span", { children: entry.compatibility.status === "compatible" ? t("compatibility.compatible") : t("compatibility.review") })]
					}),
					(0, react_jsx_runtime.jsx)("h4", { children: localize(entry.displayName, language) }),
					(0, react_jsx_runtime.jsx)("p", { children: localize(entry.summary, language) }),
					(0, react_jsx_runtime.jsxs)("dl", {
						className: ExtensionCenter_module_css_default.cardFacts,
						children: [
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("field.publisher") }), (0, react_jsx_runtime.jsx)("dd", { children: entry.publisher.name })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("field.admission") }), (0, react_jsx_runtime.jsx)("dd", { children: admissionLabel(entry, t) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("field.license") }), (0, react_jsx_runtime.jsx)("dd", { children: licenseLabel(entry, t) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("field.version") }), (0, react_jsx_runtime.jsx)("dd", { children: (0, react_jsx_runtime.jsx)("code", { children: entry.artifact.version }) })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("field.permissions") }), (0, react_jsx_runtime.jsx)("dd", { children: permissions.join(", ") || t("field.none") })] }),
							(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("field.configuration") }), (0, react_jsx_runtime.jsx)("dd", { children: entry.configuration.required ? t("configuration.required") : t("configuration.ready") })] })
						]
					}),
					(0, react_jsx_runtime.jsxs)("label", {
						className: ExtensionCenter_module_css_default.candidateScope,
						children: [(0, react_jsx_runtime.jsx)("span", { children: t("acquire.scope") }), (0, react_jsx_runtime.jsxs)("select", {
							value: selectedScope,
							disabled: !acquireAvailable,
							onChange: (event) => {
								onScope(event.currentTarget.value);
							},
							children: [(0, react_jsx_runtime.jsx)("option", {
								value: "",
								children: t("acquire.scope.placeholder")
							}), entry.scopes.map((scope) => (0, react_jsx_runtime.jsx)("option", {
								value: scope,
								disabled: !writableScope(entry, scope),
								children: scopeOption(entry, scope, t)
							}, scope))]
						})]
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: ExtensionCenter_module_css_default.cardActions,
						children: [
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"aria-expanded": detailOpen,
								"aria-controls": "extension-center-detail",
								onClick: (event) => {
									onDetails(event.currentTarget);
								},
								children: t("details.open")
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								"aria-pressed": selected,
								disabled: compareDisabled,
								onClick: onCompare,
								children: selected ? t("compare.remove") : t("compare.add")
							}),
							(0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: !acquireAvailable || !writableScope(entry, selectedScope),
								title: !acquireAvailable ? acquisitionReason ?? entry.lifecycle.install.reason ?? t("lifecycle.code") : !writableScope(entry, selectedScope) ? t("acquire.scope.required") : void 0,
								onClick: (event) => {
									onAcquire(event.currentTarget);
								},
								children: !acquireAvailable ? t("acquire.unavailable") : entry.kind === "mcp" ? t("acquire.reviewMcp") : t("acquire.review")
							})
						]
					})
				]
			});
		}
		function CandidateDetail({ entry, language, writable, unavailableReason, selectedScope, t, onScope, onLifecycle, onClose }) {
			return (0, react_jsx_runtime.jsxs)("section", {
				id: "extension-center-detail",
				className: ExtensionCenter_module_css_default.detail,
				"aria-labelledby": "extension-center-detail-heading",
				tabIndex: -1,
				children: [
					(0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("span", { children: t(`kind.${entry.kind}`) }), (0, react_jsx_runtime.jsx)("h3", {
						id: "extension-center-detail-heading",
						children: localize(entry.displayName, language)
					})] }), (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: onClose,
						children: t("details.close")
					})] }),
					(0, react_jsx_runtime.jsxs)("section", {
						className: ExtensionCenter_module_css_default.storeLifecycle,
						"aria-labelledby": "extension-center-detail-actions",
						children: [
							(0, react_jsx_runtime.jsx)("h4", {
								id: "extension-center-detail-actions",
								children: t("field.lifecycle")
							}),
							(0, react_jsx_runtime.jsxs)("label", {
								className: ExtensionCenter_module_css_default.candidateScope,
								children: [(0, react_jsx_runtime.jsx)("span", { children: t("acquire.scope") }), (0, react_jsx_runtime.jsxs)("select", {
									value: selectedScope,
									disabled: !writable,
									onChange: (event) => {
										onScope(event.currentTarget.value);
									},
									children: [(0, react_jsx_runtime.jsx)("option", {
										value: "",
										children: t("acquire.scope.placeholder")
									}), entry.scopes.map((scope) => (0, react_jsx_runtime.jsx)("option", {
										value: scope,
										disabled: !writableScope(entry, scope),
										children: scopeOption(entry, scope, t)
									}, scope))]
								})]
							}),
							(0, react_jsx_runtime.jsx)("p", { children: t("store.installOnly") }),
							(0, react_jsx_runtime.jsx)("div", {
								className: ExtensionCenter_module_css_default.lifecycleActions,
								"aria-label": t("field.lifecycle"),
								children: (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									disabled: !writable || !writableScope(entry, selectedScope) || entry.lifecycle.install.status !== "available",
									title: !writable ? unavailableReason ?? t("lifecycle.code") : !writableScope(entry, selectedScope) ? t("acquire.scope.required") : lifecycleActionLabel(entry, "install", t),
									onClick: (event) => {
										onLifecycle("install", {}, event.currentTarget);
									},
									children: entry.kind === "mcp" ? t("acquire.reviewMcp") : t("action.install")
								})
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("dl", {
						className: ExtensionCenter_module_css_default.detailFacts,
						children: [
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.publisher"),
								children: entry.publisher.name
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.admission"),
								children: admissionLabel(entry, t)
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.source"),
								children: (0, react_jsx_runtime.jsx)("a", {
									href: entry.source.url,
									target: "_blank",
									rel: "noreferrer",
									children: entry.source.label
								})
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.sourceType"),
								children: entry.source.type
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.upstream"),
								children: (0, react_jsx_runtime.jsx)("a", {
									href: entry.source.upstreamUrl,
									target: "_blank",
									rel: "noreferrer",
									children: entry.source.upstreamUrl
								})
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.admittedAt"),
								children: entry.source.admittedAt
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.license"),
								children: entry.license.sourceUrl === null ? licenseLabel(entry, t) : (0, react_jsx_runtime.jsx)("a", {
									href: entry.license.sourceUrl,
									target: "_blank",
									rel: "noreferrer",
									children: licenseLabel(entry, t)
								})
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.revision"),
								children: (0, react_jsx_runtime.jsx)("code", { children: entry.source.revision })
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t(entry.kind === "mcp" ? "field.catalogReference" : "field.artifact"),
								children: (0, react_jsx_runtime.jsxs)("code", { children: [
									entry.artifact.id,
									"@",
									entry.artifact.version,
									" · ",
									entry.artifact.sizeBytes,
									" bytes"
								] })
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t(entry.kind === "mcp" ? "field.catalogReferenceUrl" : "field.acquisitionUrl"),
								children: (0, react_jsx_runtime.jsx)("a", {
									href: entry.artifact.acquisitionUrl,
									target: "_blank",
									rel: "noreferrer",
									children: entry.artifact.acquisitionUrl
								})
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t(entry.kind === "mcp" ? "field.catalogReferenceIntegrity" : "field.integrity"),
								children: (0, react_jsx_runtime.jsx)("code", { children: entry.artifact.integrity })
							}),
							entry.kind === "mcp" ? (0, react_jsx_runtime.jsx)(Fact, {
								label: t("plan.externalRuntimeAction"),
								children: t("mcpConfig.noArtifactAcquisition")
							}) : null,
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.components"),
								children: entry.components.map((item) => localize(item, language)).join("; ") || t("field.notDeclared")
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.compatibility"),
								children: compatibilityLabel(entry, language, t)
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.dependencies"),
								children: dependencyLabel(entry, t)
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.scopes"),
								children: entry.scopes.map((item) => t(`scope.${item === "profile:web" ? "profile" : item}`)).join(", ")
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.configuration"),
								children: configurationLabel(entry, language, t)
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.conflicts"),
								children: entry.conflicts.map((item) => localize(item, language)).join("; ") || t("field.noneDeclared")
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.restart"),
								children: localize(entry.restart.detail, language)
							}),
							(0, react_jsx_runtime.jsx)(Fact, {
								label: t("field.retention"),
								children: localize(entry.retainedData, language)
							})
						]
					}),
					(0, react_jsx_runtime.jsxs)("section", {
						className: ExtensionCenter_module_css_default.disclosure,
						children: [(0, react_jsx_runtime.jsx)("h4", { children: t("field.lifecycle") }), (0, react_jsx_runtime.jsx)("ul", { children: LIFECYCLE_ACTIONS.map(([action, label]) => (0, react_jsx_runtime.jsx)("li", { children: (0, react_jsx_runtime.jsxs)("strong", { children: [
							t(label),
							" · ",
							lifecycleActionLabel(entry, action, t, unavailableReason)
						] }) }, action)) })]
					}),
					isCapabilityResolverCandidate(entry.candidateRef) ? (0, react_jsx_runtime.jsx)(ResolverConfigDisclosure, { t }) : null,
					(0, react_jsx_runtime.jsxs)("section", {
						className: ExtensionCenter_module_css_default.disclosure,
						children: [(0, react_jsx_runtime.jsx)("h4", { children: t("field.permissions") }), (0, react_jsx_runtime.jsx)("ul", { children: entry.permissions.map((permission, index) => (0, react_jsx_runtime.jsxs)("li", { children: [(0, react_jsx_runtime.jsxs)("strong", { children: [
							t(`phase.${permission.phase}`),
							" · ",
							t(`permission.${permission.kind === "model-context" ? "model" : permission.kind}`),
							" · ",
							permission.access
						] }), (0, react_jsx_runtime.jsx)("span", { children: localize(permission.detail, language) })] }, `${permission.phase}-${permission.kind}-${index}`)) })]
					}),
					(0, react_jsx_runtime.jsxs)("section", {
						className: ExtensionCenter_module_css_default.disclosure,
						children: [(0, react_jsx_runtime.jsx)("h4", { children: t("field.verification") }), (0, react_jsx_runtime.jsx)("ul", { children: entry.verification.map((claim, index) => (0, react_jsx_runtime.jsxs)("li", { children: [(0, react_jsx_runtime.jsxs)("strong", { children: [
							localize(claim.claim, language),
							" · ",
							t(`verification.${claim.status}`)
						] }), (0, react_jsx_runtime.jsx)("span", { children: localize(claim.detail, language) })] }, index)) })]
					})
				]
			});
		}
		function Fact({ label, children }) {
			return (0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: label }), (0, react_jsx_runtime.jsx)("dd", { children })] });
		}
		function Comparison({ entries, language, t, unavailableReason, onClose }) {
			const rows = [
				["field.type", (entry) => t(`kind.${entry.kind}`)],
				["field.publisher", (entry) => entry.publisher.name],
				["field.admission", (entry) => admissionLabel(entry, t)],
				["field.license", (entry) => licenseLabel(entry, t)],
				["field.version", (entry) => entry.artifact.version],
				["field.revision", (entry) => entry.source.revision],
				["field.artifact", (entry) => artifactLabel(entry)],
				["field.integrity", (entry) => entry.artifact.integrity],
				["field.source", (entry) => sourceLabel(entry)],
				["field.components", (entry) => entry.components.map((component) => localize(component, language)).join("; ") || t("field.notDeclared")],
				["field.compatibility", (entry) => compatibilityLabel(entry, language, t)],
				["field.dependencies", (entry) => dependencyLabel(entry, t)],
				["field.scopes", (entry) => entry.scopes.map((scope) => t(`scope.${scope === "profile:web" ? "profile" : scope}`)).join(", ")],
				["field.configuration", (entry) => configurationLabel(entry, language, t)],
				["field.acquisitionAuthority", (entry) => permissionLabel(entry, "acquisition", language, t)],
				["field.runtimeAuthority", (entry) => permissionLabel(entry, "runtime", language, t)],
				["field.conflicts", (entry) => entry.conflicts.map((conflict) => localize(conflict, language)).join("; ") || t("field.noneDeclared")],
				["field.restart", (entry) => `${entry.restart.required ? t("restart.required") : t("restart.notRequired")} · ${localize(entry.restart.detail, language)}`],
				...LIFECYCLE_ACTIONS.map(([action, label]) => [label, (entry) => lifecycleActionLabel(entry, action, t, unavailableReason(entry))]),
				["field.verification", (entry) => verificationLabel(entry, language, t)],
				["field.retention", (entry) => localize(entry.retainedData, language)]
			];
			return (0, react_jsx_runtime.jsxs)("section", {
				id: "extension-center-comparison",
				className: ExtensionCenter_module_css_default.comparison,
				"aria-labelledby": "extension-center-comparison-heading",
				tabIndex: -1,
				children: [(0, react_jsx_runtime.jsxs)("header", { children: [(0, react_jsx_runtime.jsx)("h3", {
					id: "extension-center-comparison-heading",
					children: t("compare.heading")
				}), (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					onClick: onClose,
					children: t("compare.close")
				})] }), (0, react_jsx_runtime.jsx)("div", {
					className: ExtensionCenter_module_css_default.tableScroll,
					children: (0, react_jsx_runtime.jsxs)("table", { children: [(0, react_jsx_runtime.jsx)("thead", { children: (0, react_jsx_runtime.jsxs)("tr", { children: [(0, react_jsx_runtime.jsx)("th", {
						scope: "col",
						children: t("compare.field")
					}), entries.map((entry) => (0, react_jsx_runtime.jsx)("th", {
						scope: "col",
						children: localize(entry.displayName, language)
					}, entry.candidateRef))] }) }), (0, react_jsx_runtime.jsx)("tbody", { children: rows.map(([label, value]) => (0, react_jsx_runtime.jsxs)("tr", { children: [(0, react_jsx_runtime.jsx)("th", {
						scope: "row",
						children: t(label)
					}), entries.map((entry) => (0, react_jsx_runtime.jsx)("td", { children: value(entry) }, entry.candidateRef))] }, label)) })] })
				})]
			});
		}
		function LifecycleUnavailable({ t, capabilities, error, retry }) {
			return (0, react_jsx_runtime.jsxs)("section", {
				className: ExtensionCenter_module_css_default.lifecycle,
				role: "status",
				children: [
					(0, react_jsx_runtime.jsxs)("div", { children: [
						(0, react_jsx_runtime.jsx)("h3", { children: t("lifecycle.heading") }),
						(0, react_jsx_runtime.jsx)("p", { children: t("lifecycle.body") }),
						(0, react_jsx_runtime.jsx)("code", { children: t("lifecycle.code") }),
						error === void 0 ? null : (0, react_jsx_runtime.jsx)("code", { children: error }),
						retry === void 0 ? null : (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							onClick: retry,
							children: t("management.retry")
						})
					] }),
					(0, react_jsx_runtime.jsx)(HostCapabilityStatus, {
						capabilities,
						t
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: ExtensionCenter_module_css_default.actions,
						"aria-label": t("lifecycle.heading"),
						children: [
							"action.install",
							"action.configure",
							"action.update",
							"action.uninstall",
							"action.restore"
						].map((action) => (0, react_jsx_runtime.jsx)("button", {
							type: "button",
							disabled: true,
							title: t("lifecycle.code"),
							children: t(action)
						}, action))
					})
				]
			});
		}
		//#endregion
		//#region lib/.build/client/ExtensionCenter.js
		/** Locale namespace registered by the Extension Center Client plugin. */
		const EXTENSION_CENTER_LOCALE = "extension-center";
		const TABS = [
			{
				id: "store",
				label: "tab.store"
			},
			{
				id: "installed",
				label: "tab.installed"
			},
			{
				id: "updates",
				label: "tab.updates"
			},
			{
				id: "activity",
				label: "tab.activity"
			}
		];
		const DEFAULT_MANAGEMENT_CONTEXT = {
			profileId: "web",
			defaultScopeKey: "profile:web"
		};
		/** Render the first-level sidebar action and restore focus after every dialog close path. */
		function ExtensionCenterTrigger({ wide, useStore, actions, t }) {
			const open = useStore((state) => state.open);
			const trigger = (0, react.useRef)(null);
			const wasOpen = (0, react.useRef)(false);
			(0, react.useEffect)(() => {
				if (wasOpen.current && !open) trigger.current?.focus();
				wasOpen.current = open;
			}, [open]);
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Tooltip, {
				label: t("trigger"),
				delayMs: 500,
				disabled: wide,
				children: (0, react_jsx_runtime.jsxs)("button", {
					ref: trigger,
					type: "button",
					className: ExtensionCenter_module_css_default.trigger,
					"data-extension-center-entry": "true",
					"data-wide": wide ? "true" : "false",
					"aria-label": t("trigger"),
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					onClick: actions.openStore,
					children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPersonalizationOutline16, {
						size: wide ? 16 : 18,
						"aria-hidden": "true"
					}), wide ? (0, react_jsx_runtime.jsx)("span", { children: t("trigger") }) : null]
				})
			});
		}
		/** Render the Store-default dialog from the additive shell overlay slot. */
		function ExtensionCenterOverlay({ useStore, actions, t, catalog, management, managementContext = DEFAULT_MANAGEMENT_CONTEXT }) {
			const open = useStore((state) => state.open);
			const active = useStore((state) => state.active);
			const id = (0, react.useId)();
			const surface = (0, react.useRef)(null);
			const storeTab = (0, react.useRef)(null);
			const [catalogEntries, setCatalogEntries] = (0, react.useState)([]);
			const candidates = (0, react.useMemo)(() => new Map(catalogEntries.map((entry) => [entry.candidateRef, entry])), [catalogEntries]);
			(0, react.useEffect)(() => {
				if (open) storeTab.current?.focus();
			}, [open]);
			(0, react.useEffect)(() => {
				if (!open) {
					setCatalogEntries([]);
					return;
				}
				const controller = new AbortController();
				setCatalogEntries([]);
				catalog.list(controller.signal).then((snapshot) => {
					setCatalogEntries(snapshot.entries);
				}).catch(() => {
					if (!controller.signal.aborted) setCatalogEntries([]);
				});
				return () => {
					controller.abort();
				};
			}, [catalog, open]);
			(0, react.useEffect)(() => {
				if (!open) return;
				const keepFocusInside = (event) => {
					if (event.key !== "Tab") return;
					const focusable = [...surface.current?.querySelectorAll("button:not(:disabled):not([tabindex=\"-1\"]), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex=\"-1\"])") ?? []].filter((element) => element.closest("[hidden]") === null);
					if (focusable.length === 0) return;
					const first = focusable[0];
					const last = focusable.at(-1);
					if (first === void 0 || last === void 0) return;
					if (event.shiftKey && document.activeElement === first) {
						event.preventDefault();
						last.focus();
					} else if (!event.shiftKey && document.activeElement === last) {
						event.preventDefault();
						first.focus();
					}
				};
				document.addEventListener("keydown", keepFocusInside);
				return () => {
					document.removeEventListener("keydown", keepFocusInside);
				};
			}, [open]);
			const tabId = (view) => `${id}-tab-${view}`;
			const panelId = (view) => `${id}-panel-${view}`;
			const moveTab = (event, current) => {
				const index = TABS.findIndex((tab) => tab.id === current);
				let next = index;
				if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
				else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
				else if (event.key === "Home") next = 0;
				else if (event.key === "End") next = TABS.length - 1;
				else return;
				event.preventDefault();
				const view = TABS[next]?.id;
				if (view === void 0) return;
				actions.select(view);
				document.getElementById(tabId(view))?.focus();
			};
			return (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
				open,
				onClose: actions.close,
				title: t("title"),
				headless: true,
				className: ExtensionCenter_module_css_default.dialog,
				children: (0, react_jsx_runtime.jsxs)("div", {
					ref: surface,
					className: ExtensionCenter_module_css_default.surface,
					"data-extension-center-surface": "true",
					children: [
						(0, react_jsx_runtime.jsxs)("header", {
							className: ExtensionCenter_module_css_default.header,
							children: [(0, react_jsx_runtime.jsxs)("div", {
								className: ExtensionCenter_module_css_default.titleBlock,
								children: [
									(0, react_jsx_runtime.jsxs)("div", {
										className: ExtensionCenter_module_css_default.eyebrow,
										children: [(0, react_jsx_runtime.jsx)("span", { children: t("preview") }), (0, react_jsx_runtime.jsx)("span", {
											className: ExtensionCenter_module_css_default.host,
											children: t("host")
										})]
									}),
									(0, react_jsx_runtime.jsx)("h2", { children: t("title") }),
									(0, react_jsx_runtime.jsx)("p", { children: t("description") })
								]
							}), (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								className: ExtensionCenter_module_css_default.close,
								"aria-label": t("close"),
								onClick: actions.close,
								children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconCloseOutline16, {
									size: 16,
									"aria-hidden": "true"
								})
							})]
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: ExtensionCenter_module_css_default.tabs,
							role: "tablist",
							"aria-label": t("views"),
							children: TABS.map((tab) => (0, react_jsx_runtime.jsx)("button", {
								ref: tab.id === "store" ? storeTab : void 0,
								id: tabId(tab.id),
								type: "button",
								role: "tab",
								"aria-selected": active === tab.id,
								"aria-controls": panelId(tab.id),
								tabIndex: active === tab.id ? 0 : -1,
								onClick: () => {
									actions.select(tab.id);
								},
								onKeyDown: (event) => {
									moveTab(event, tab.id);
								},
								children: t(tab.label)
							}, tab.id))
						}),
						(0, react_jsx_runtime.jsx)("div", {
							className: ExtensionCenter_module_css_default.panels,
							children: TABS.map((tab) => (0, react_jsx_runtime.jsxs)("section", {
								id: panelId(tab.id),
								role: "tabpanel",
								"aria-labelledby": tabId(tab.id),
								hidden: active !== tab.id,
								className: ExtensionCenter_module_css_default.panel,
								children: [
									tab.id === "store" && active === "store" ? (0, react_jsx_runtime.jsx)(StorePanel, {
										t,
										catalog,
										management,
										context: managementContext
									}) : null,
									tab.id === "installed" && active === "installed" ? (0, react_jsx_runtime.jsx)(InstalledPanel, {
										management,
										context: managementContext,
										candidates,
										t
									}) : null,
									tab.id === "updates" && active === "updates" ? (0, react_jsx_runtime.jsx)(UpdatesPanel, {
										management,
										context: managementContext,
										candidates,
										t
									}) : null,
									tab.id === "activity" && active === "activity" ? (0, react_jsx_runtime.jsx)(ActivityPanel, {
										management,
										context: managementContext,
										candidates,
										t
									}) : null
								]
							}, tab.id))
						})
					]
				})
			});
		}
		/** Bind private catalog and management clients without placing them in generic slot options. */
		function bindExtensionCenterOverlay(catalog, management, managementContext = DEFAULT_MANAGEMENT_CONTEXT) {
			return function BoundExtensionCenterOverlay(props) {
				return (0, react_jsx_runtime.jsx)(ExtensionCenterOverlay, {
					...props,
					catalog,
					management,
					managementContext
				});
			};
		}
		//#endregion
		//#region lib/.build/client/locales.js
		/** English Extension Center copy. */
		const en = {
			"locale.code": "en",
			trigger: "Extensions",
			title: "Extension Store",
			close: "Close Extension Store",
			description: "Discover Plugin, MCP server, and Skill candidates from one verified local catalog.",
			preview: "Trusted extension catalog",
			host: "DSH 0.1.2-alpha.1",
			views: "Extension Center views",
			"tab.store": "Store",
			"tab.installed": "Installed",
			"tab.updates": "Updates",
			"tab.activity": "Activity & Recovery",
			"catalog.loading": "Verifying the admitted catalog…",
			"catalog.unavailable": "Discovery unavailable",
			"catalog.unavailable.body": "The Host did not return a verified catalog. No candidate from an unverified payload is shown.",
			"catalog.retry": "Retry catalog",
			"catalog.refresh": "Refresh signed catalog",
			"catalog.status": "Verified catalog status",
			"catalog.verified": "Signed catalog verified",
			"catalog.revision": "Revision",
			"catalog.candidates": "candidates",
			"catalog.source": "Source",
			"catalog.freshness": "Freshness",
			"catalog.lastRefresh": "Last refresh",
			"catalog.degraded": "Using last-good catalog",
			"catalog.offline": "Search, filters, details, task matching, and comparison use this same local snapshot. Refresh sends no task or query text.",
			"store.heading": "Browse the admitted catalog",
			"store.body": "Search names, outcomes, publishers, and tags, then narrow by type, scope, configuration, authority, or lifecycle availability.",
			"store.installOnly": "The Store creates new managed targets. Configure, update, uninstall, and restore an existing target from Installed.",
			"search.label": "Search extensions",
			"search.placeholder": "Try files, documentation, discovery…",
			"filter.all": "All",
			"filter.kind": "Type",
			"filter.scope": "Scope",
			"filter.configuration": "Configuration",
			"filter.permission": "Authority",
			"filter.lifecycle": "Lifecycle",
			"kind.plugin": "Plugin",
			"kind.mcp": "MCP server",
			"kind.skill": "Skill",
			"scope.profile": "Web Profile",
			"scope.user": "User",
			"scope.project": "Project",
			"scope.projectUnavailable": "Project (read-only until a workspace and Agent selector is available)",
			"configuration.ready": "No initial configuration",
			"configuration.required": "Configuration required",
			"permission.network": "Network",
			"permission.filesystem": "Filesystem",
			"permission.subprocess": "Subprocess",
			"permission.credentials": "Credentials",
			"permission.model": "Model context",
			"lifecycle.complete": "Complete lifecycle",
			"lifecycle.blocked": "Blocked on this Host",
			"results.showing": "Showing",
			"results.label": "Catalog candidates",
			"results.empty": "No admitted candidate matches",
			"results.empty.body": "Change the local query or filters. This result does not trigger a Web fallback.",
			"compare.open": "Compare selected",
			"compare.add": "Add to compare",
			"compare.remove": "Remove from compare",
			"compare.heading": "Candidate comparison",
			"compare.close": "Close comparison",
			"compare.field": "Field",
			"details.open": "View details",
			"details.close": "Close details",
			"acquire.unavailable": "Acquire unavailable",
			"acquire.review": "Review install",
			"acquire.reviewMcp": "Add connection",
			"acquire.scope": "Target scope",
			"acquire.scope.placeholder": "Choose a scope…",
			"acquire.scope.required": "Choose the exact target scope before previewing a plan.",
			"compatibility.compatible": "Compatible",
			"compatibility.review": "Compatibility review required",
			"field.type": "Type",
			"field.publisher": "Publisher",
			"field.admission": "Catalog admission channel",
			"field.license": "License",
			"field.version": "Exact version",
			"field.permissions": "Authority",
			"field.acquisitionAuthority": "Acquisition authority",
			"field.runtimeAuthority": "Runtime authority",
			"field.configuration": "Configuration",
			"field.source": "Admitted source",
			"field.sourceType": "Source type",
			"field.upstream": "Upstream project",
			"field.admittedAt": "Catalog admission time",
			"field.revision": "Source revision",
			"field.artifact": "Artifact",
			"field.acquisitionUrl": "Exact acquisition URL",
			"field.catalogReference": "Catalog package reference (not acquired)",
			"field.catalogReferenceUrl": "Catalog package reference URL",
			"field.catalogReferenceVersion": "Catalog package reference version",
			"field.catalogReferenceIntegrity": "Catalog package reference integrity",
			"field.integrity": "Integrity",
			"field.components": "Components",
			"field.compatibility": "Compatibility evidence",
			"field.dependencies": "Dependencies",
			"field.scopes": "Target scopes",
			"field.conflicts": "Conflicts",
			"field.restart": "Activation / restart",
			"field.verification": "Verification evidence",
			"field.retention": "Retained data and rollback limit",
			"field.lifecycle": "Lifecycle",
			"field.lifecycle.install": "Install availability",
			"field.lifecycle.configure": "Configure availability",
			"field.lifecycle.update": "Update availability",
			"field.lifecycle.uninstall": "Uninstall availability",
			"field.lifecycle.restore": "Restore availability",
			"field.credentials": "Credentials",
			"field.none": "None",
			"field.noneDeclared": "None declared",
			"field.notDeclared": "Not declared",
			"publisher.community": "Community catalog admission",
			"publisher.registry": "Upstream registry admission",
			"license.verified": "Verified at pinned revision",
			"license.declared": "Publisher-declared",
			"license.unknown": "Unknown",
			"phase.acquisition": "Acquisition",
			"phase.runtime": "Runtime",
			"dependency.host": "Host dependency",
			"dependency.runtime": "Runtime dependency",
			"dependency.extension": "Extension dependency",
			"dependency.required": "Required",
			"dependency.optional": "Optional",
			"credentials.none": "None",
			"credentials.optional": "Optional",
			"credentials.required": "Required",
			"verification.verified": "Verified",
			"verification.declared": "Publisher-declared",
			"verification.unknown": "Unknown",
			"restart.required": "External restart required",
			"restart.notRequired": "No restart declared",
			"installed.heading": "Managed inventory",
			"installed.body": "Desired, materialized, effective, Agent visibility, verification, rollback, and ownership remain independent facts.",
			"updates.heading": "Exact updates",
			"updates.body": "Every update is one observed, integrity-pinned target. Nothing is selected or applied automatically.",
			"activity.heading": "Activity & Recovery",
			"activity.body": "Verified operation projections and terminal receipts remain separate from recovery actions.",
			"lifecycle.heading": "Lifecycle actions unavailable on this Host",
			"lifecycle.body": "Writable P0 requires the Center-managed Plugin, MCP, and continuation lifecycles plus the official Skill, tool, and Loader registries.",
			"lifecycle.code": "unavailable(host-capability)",
			"lifecycle.available": "Available",
			"lifecycle.unavailable": "Unavailable",
			"capability.heading": "Writable Host preflight",
			"capability.managedPluginLifecycle": "Managed Plugin lifecycle",
			"capability.dynamicMcpConnection": "Dynamic MCP connections",
			"capability.durableContinuation": "Durable continuation",
			"capability.skillRegistry": "Skill registry",
			"capability.toolRegistry": "Tool registry",
			"capability.loaderMutation": "Loader mutation",
			"capability.ready": "Ready",
			"capability.missing": "Missing",
			"action.install": "Install",
			"action.configure": "Configure",
			"action.update": "Update",
			"action.enable": "Enable",
			"action.disable": "Disable",
			"action.uninstall": "Uninstall",
			"action.restore": "Restore",
			"action.recover": "Retry exact recovery",
			"action.verify": "Verify current state",
			"action.purge": "Purge retained data",
			"action.retry": "Retry preview",
			"action.cancel": "Cancel",
			"action.noCandidate": "No admitted candidate is bound to this row.",
			"management.unavailable": "Management unavailable",
			"management.unavailable.body": "The Host did not return a valid management projection. No lifecycle action is treated as successful.",
			"management.retry": "Retry management",
			"inventory.loading": "Reading normalized inventory…",
			"inventory.incomplete": "This observation is incomplete. State and actions may not be current.",
			"inventory.empty": "No extensions in this scope",
			"inventory.empty.body": "The current Web Profile inventory returned no managed or external rows.",
			"inventory.list": "Extension inventory",
			"inventory.verify.failed": "Owner verification failed",
			"inventory.verify.running": "Verifying…",
			"state.desired": "Desired",
			"state.materialized": "Materialized",
			"state.effective": "Effective",
			"state.visibility": "Agent visibility",
			"state.verification": "Verification",
			"state.rollback": "Rollback",
			"state.ownership": "Ownership",
			"state.configuration": "Configuration revision",
			"configure.heading": "Staged configuration draft",
			"configure.body": "Save creates a new immutable Configure plan. Discard performs no Host request.",
			"configure.json": "Configuration JSON",
			"configure.save": "Save and review",
			"configure.discard": "Discard draft",
			"configure.invalid": "Enter strict JSON before saving this draft.",
			"resolverConfig.heading": "Capability Resolver settings",
			"resolverConfig.body": "Only these ten integer fields are accepted. Save creates a staged Configure plan; the Host validates them again.",
			"resolverConfig.schema": "Typed Configure fields",
			"resolverConfig.integer": "Integer",
			"resolverConfig.staleRule": "staleCacheMs must be greater than or equal to freshCacheMs.",
			"resolverConfig.invalid": "The value is outside its admitted range:",
			"skillConfig.heading": "Skill target settings",
			"skillConfig.body": "Choose where this Skill is visible and which invocation surfaces may use it.",
			"skillConfig.projectRoot": "Canonical project root",
			"skillConfig.projectRoot.body": "Enter the absolute real project directory. The Host rejects aliases and non-canonical paths.",
			"skillConfig.modelInvocable": "Model may invoke this Skill",
			"skillConfig.userInvocable": "User may invoke this Skill",
			"mcpConfig.heading": "MCP connection settings",
			"mcpConfig.body": "Select one exact Host-provisioned stdio runtime or unauthenticated HTTPS connection. No server package or URL is accepted from the Agent.",
			"mcpConfig.runtimeMissing": "No admitted runtime is provisioned",
			"mcpConfig.runtimeMissing.body": "The Store manages connections only. An administrator must first provision the exact integrity-pinned runtime in the Host allowlist.",
			"mcpConfig.runtime": "Host-provisioned runtime",
			"mcpConfig.noArtifactAcquisition": "No external runtime download; this plan manages only the connection bound to the exact Host-provisioned runtime.",
			"mcpConfig.connectionId": "Connection name",
			"mcpConfig.executable": "Executable",
			"mcpConfig.arguments": "Fixed arguments",
			"mcpConfig.workingDirectory": "Working directory",
			"mcpConfig.none": "none",
			"mcpConfig.origin": "HTTPS origin",
			"mcpConfig.endpoint": "Exact MCP endpoint",
			"mcpConfig.dataEgress": "Data sent to this origin",
			"mcpConfig.httpPolicy": "Unauthenticated; no custom headers or credentials; redirects fail closed.",
			"mcpConfig.roots": "Allowed filesystem roots",
			"mcpConfig.roots.body": "One canonical absolute directory per line. The Agent does not choose these roots.",
			"mcpConfig.timeout": "Tool-call timeout (ms)",
			"mcpConfig.reconnect": "Reconnect automatically",
			"mcpConfig.initialDelay": "Initial delay (ms)",
			"mcpConfig.maxDelay": "Maximum delay (ms)",
			"mcpConfig.maxAttempts": "Maximum attempts",
			"mcpConfig.selected": "Selected admission",
			"updates.loading": "Checking exact update observations…",
			"updates.empty": "No exact update observed",
			"updates.empty.body": "Unknown or moving targets are never shown as available updates.",
			"updates.list": "Available exact updates",
			"updates.candidate": "Admitted candidate",
			"updates.exactTarget": "Exact target",
			"activity.loading": "Verifying operations and receipts…",
			"activity.empty": "No lifecycle operation has run",
			"activity.empty.body": "Catalog reads and plan previews create no lifecycle receipt.",
			"activity.list": "Lifecycle operations",
			"taskAttempt.heading": "Original task attempts",
			"taskAttempt.body": "Task progress and outcomes remain separate from extension operations. Candidate selection and Retry original always create a new attempt.",
			"taskAttempt.empty": "No capability task attempt has been recorded.",
			"taskAttempt.id": "Task attempt",
			"taskAttempt.phase": "Current phase",
			"taskAttempt.outcome": "Terminal outcome",
			"taskAttempt.active": "This attempt is still active.",
			"taskAttempt.parent": "Previous attempt",
			"taskAttempt.choice": "Choose one admitted candidate. This does not approve acquisition.",
			"taskAttempt.select": "Select",
			"taskAttempt.management": "Complete this action in Extensions, then retry:",
			"taskAttempt.extensionRef": "Opaque extension reference",
			"taskAttempt.retryOriginal": "Retry original task",
			"taskAttempt.candidate": "Candidate awaiting its normal acquisition request or approval flow",
			"taskAttempt.cancel": "Cancel task attempt",
			"taskAttempt.cancelContinuation": "Cancel continuation",
			"taskAttempt.derived": "A new attempt has already been created from this terminal result.",
			"taskAttempt.retryContinuation": "Original-task continuation:",
			"taskAttempt.retryContinuation.pending": "Waiting for capability verification",
			"taskAttempt.retryContinuation.ready": "Verified and queued to continue",
			"taskAttempt.retryContinuation.consumed": "Verified; waiting for a dispatch owner",
			"taskAttempt.retryContinuation.dispatching": "A fenced owner is dispatching the continuation",
			"taskAttempt.retryContinuation.dispatched": "Continuation durably queued",
			"taskAttempt.retryContinuation.claimed": "Continuation claimed by the Agent",
			"taskAttempt.retryContinuation.deliveryUnknown": "Delivery is unknown; automatic retry is blocked",
			"taskAttempt.retryContinuation.canceled": "Continuation canceled",
			"taskAttempt.retryContinuation.superseded": "Continuation superseded by a newer task attempt",
			"taskAttempt.retryContinuation.expired": "Continuation expired",
			"taskAttempt.retryContinuation.invalid": "Continuation invalid; it will not run",
			"taskAttempt.retryContinuation.reconciling": "Continuation reservation awaits Host reconciliation",
			"taskAttempt.retryContinuation.unavailable": "Continuation state unavailable from this Host",
			"approval.heading": "Task acquisition approvals",
			"approval.body": "These exact plans came from Agent capability-gap detection. No mutation runs until you approve one hash.",
			"approval.empty": "No task plan awaits review.",
			"approval.review": "Review task plan",
			"approval.configuration.heading": "Task configuration requests",
			"approval.configuration.body": "The Agent found an admitted candidate but cannot choose filesystem roots or a Host runtime for you. Configure it here before any plan exists.",
			"approval.configuration.empty": "No task candidate is waiting for configuration.",
			"approval.configuration.required": "configuration-required",
			"approval.configuration.open": "Configure task candidate",
			"approval.configuration.saving": "Creating the exact task plan…",
			"operation.id": "Operation",
			"operation.phase": "Phase",
			"operation.updated": "Last journal event",
			"operation.started": "Lifecycle operation finished",
			"operation.restartRequired": "External restart required",
			"operation.uncertain": "Decision result requires reconciliation",
			"operation.uncertain.body": "Do not submit a second grant. Close this review and check Activity & Recovery.",
			"operation.notRecorded": "The Host proves the plan is still pending. You may make a new explicit decision.",
			"operation.resume": "Resume approved plan",
			"operation.resuming": "Resuming approved plan…",
			"receipt.pending": "No terminal receipt has been issued.",
			"receipt.outcome": "Receipt outcome",
			"receipt.source": "Source",
			"receipt.version": "Version",
			"receipt.integrity": "Integrity",
			"receipt.scope": "Scope / Profile",
			"receipt.configuration": "Configuration digest",
			"receipt.authority": "Authority digest",
			"receipt.retention": "Retention disclosure digest",
			"receipt.mutation": "Mutation evidence",
			"receipt.verification": "Verification evidence",
			"receipt.rollback": "Rollback evidence",
			"receipt.restart": "Restart evidence",
			"receipt.recovery": "Recovery evidence",
			"receipt.notProven": "Not proven",
			"receipt.digest": "Receipt digest",
			"receipt.journal": "Journal evidence",
			"review.heading": "Exact review evidence",
			"review.body": "These secret-free facts are part of the immutable plan hash and terminal receipt.",
			"review.checks": "Checks planned",
			"review.checksRun": "Checks actually completed",
			"review.removed": "Material removed",
			"review.retained": "Material retained",
			"review.credentials": "Credential choice",
			"review.rollback": "Pinned rollback point",
			"review.limits": "Rollback limits",
			"review.notProven": "Still not proven",
			"review.plugin": "Plugin package, Center-owned material, Loader activation, scripts, and settings",
			"review.skill": "Complete Skill file, content, links, executable bits, and invocation",
			"review.mcp": "Exact MCP descriptor, runtime, credentials, and data egress",
			"recovery.required": "Recovery required",
			"recovery.required.body": "The prior operation could not complete its fenced rollback. Retry only this locked operation; no new authority is granted.",
			"recovery.running": "Retrying exact recovery…",
			"recovery.command": "Standalone recovery argv",
			"recovery.reconciliationPending": "The Profile restore can finish before the Center journal is reconciled. Journal reconciliation is pending.",
			"recovery.retiredRuntime": "This operation is quarantined because its pinned private pnpm runtime was retired for security. The old runtime will not execute; the target remains locked for a current-version recovery path.",
			"plan.loading": "Minting an immutable preview…",
			"plan.unavailable": "Plan preview unavailable",
			"plan.unavailable.body": "No decision can be made until the Host returns one valid, exact plan.",
			"plan.eyebrow": "No mutation has been authorized",
			"plan.heading": "Review exact lifecycle plan",
			"plan.body": "Approve or reject this one hash. Approval is single-use and does not apply to another operation, scope, or version.",
			"plan.close": "Close plan review",
			"plan.denied": "Policy denied this plan",
			"plan.candidateUnavailable": "Exact candidate disclosure unavailable",
			"plan.candidateUnavailable.body": "The catalog entry does not match this plan version and integrity. Approval is disabled; rejection remains safe.",
			"plan.expired": "Plan expired",
			"plan.expired.body": "This hash is outside its authorization window. Close it and create a new preview.",
			"plan.operation": "Operation",
			"plan.candidate": "Candidate reference",
			"plan.target": "Managed target",
			"plan.scope": "Scope / Profile",
			"plan.desired": "Desired state",
			"plan.managedObject": "Managed object",
			"plan.externalRuntimeAction": "External runtime action",
			"plan.runtimeRef": "Bound runtime reference",
			"plan.runtimeVersion": "Bound runtime version",
			"plan.runtimeDescriptorDigest": "Runtime descriptor digest",
			"plan.authorityDigest": "Authority digest",
			"plan.mutationDigest": "Mutation digest",
			"plan.verificationDigest": "Verification digest",
			"plan.configurationDiff": "Staged configuration diff",
			"plan.configurationDigest": "Configuration digest",
			"plan.digesting": "Computing digest…",
			"plan.digestUnavailable": "Digest unavailable",
			"plan.hash": "Plan hash",
			"plan.expires": "Expires",
			"plan.singleUse": "Authorization",
			"plan.singleUse.yes": "One exact decision; single-use",
			"plan.decision": "Human plan decision",
			"plan.reject": "Reject plan",
			"plan.rejecting": "Rejecting…",
			"plan.approve": "Approve exact plan",
			"plan.approving": "Approving…",
			"plan.rejected": "Plan rejected",
			"plan.rejected.body": "No lifecycle request was sent and this plan cannot be approved later."
		};
		/** Simplified Chinese Extension Center copy. */
		const zh = {
			"locale.code": "zh",
			trigger: "扩展",
			title: "扩展商店",
			close: "关闭扩展商店",
			description: "从一个经过验证的本地目录发现 Plugin、MCP Server 与 Skill 候选。",
			preview: "受信扩展目录",
			host: "DSH 0.1.2-alpha.1",
			views: "扩展中心视图",
			"tab.store": "商店",
			"tab.installed": "已安装",
			"tab.updates": "更新",
			"tab.activity": "活动与恢复",
			"catalog.loading": "正在验证准入目录…",
			"catalog.unavailable": "发现不可用",
			"catalog.unavailable.body": "Host 没有返回验证通过的目录；不会展示未验证 payload 中的任何候选。",
			"catalog.retry": "重试目录",
			"catalog.refresh": "刷新签名目录",
			"catalog.status": "已验证目录状态",
			"catalog.verified": "签名目录已验证",
			"catalog.revision": "Revision",
			"catalog.candidates": "个候选",
			"catalog.source": "来源",
			"catalog.freshness": "新鲜度",
			"catalog.lastRefresh": "上次刷新",
			"catalog.degraded": "正在使用 last-good 目录",
			"catalog.offline": "搜索、筛选、详情、任务匹配和比较共用这份本地快照；刷新不会发送任务或查询文本。",
			"store.heading": "浏览准入目录",
			"store.body": "按名称、结果、发布者和标签搜索，再按类型、作用域、配置、权限或生命周期可用性筛选。",
			"store.installOnly": "商店只创建新的受管目标。已有目标的配置、更新、卸载与还原请在“已安装”中操作。",
			"search.label": "搜索扩展",
			"search.placeholder": "例如：文件、文档、发现…",
			"filter.all": "全部",
			"filter.kind": "类型",
			"filter.scope": "作用域",
			"filter.configuration": "配置",
			"filter.permission": "权限",
			"filter.lifecycle": "生命周期",
			"kind.plugin": "Plugin",
			"kind.mcp": "MCP Server",
			"kind.skill": "Skill",
			"scope.profile": "Web Profile",
			"scope.user": "用户",
			"scope.project": "项目",
			"scope.projectUnavailable": "项目（发布 workspace 与 Agent selector 前只读）",
			"configuration.ready": "无需初始配置",
			"configuration.required": "需要配置",
			"permission.network": "网络",
			"permission.filesystem": "文件系统",
			"permission.subprocess": "子进程",
			"permission.credentials": "凭据",
			"permission.model": "模型上下文",
			"lifecycle.complete": "完整生命周期",
			"lifecycle.blocked": "当前 Host 阻塞",
			"results.showing": "当前显示",
			"results.label": "目录候选",
			"results.empty": "没有匹配的准入候选",
			"results.empty.body": "请修改本地查询或筛选条件；该结果不会触发 Web fallback。",
			"compare.open": "比较已选项",
			"compare.add": "加入比较",
			"compare.remove": "移出比较",
			"compare.heading": "候选比较",
			"compare.close": "关闭比较",
			"compare.field": "字段",
			"details.open": "查看详情",
			"details.close": "关闭详情",
			"acquire.unavailable": "获取不可用",
			"acquire.review": "审查安装计划",
			"acquire.reviewMcp": "添加连接",
			"acquire.scope": "目标作用域",
			"acquire.scope.placeholder": "选择作用域…",
			"acquire.scope.required": "必须先明确选择准确目标作用域，才能预览计划。",
			"compatibility.compatible": "兼容",
			"compatibility.review": "需要兼容性审查",
			"field.type": "类型",
			"field.publisher": "发布者",
			"field.admission": "目录准入通道",
			"field.license": "许可证",
			"field.version": "准确版本",
			"field.permissions": "权限",
			"field.acquisitionAuthority": "获取期权限",
			"field.runtimeAuthority": "运行期权限",
			"field.configuration": "配置",
			"field.source": "准入来源",
			"field.sourceType": "来源类型",
			"field.upstream": "上游项目",
			"field.admittedAt": "目录准入时间",
			"field.revision": "来源 revision",
			"field.artifact": "物料",
			"field.acquisitionUrl": "准确获取地址",
			"field.catalogReference": "目录包引用（不获取）",
			"field.catalogReferenceUrl": "目录包引用地址",
			"field.catalogReferenceVersion": "目录包引用版本",
			"field.catalogReferenceIntegrity": "目录包引用 Integrity",
			"field.integrity": "Integrity",
			"field.components": "组件",
			"field.compatibility": "兼容性证据",
			"field.dependencies": "依赖",
			"field.scopes": "目标作用域",
			"field.conflicts": "冲突",
			"field.restart": "生效与重启",
			"field.verification": "验证证据",
			"field.retention": "保留数据与回滚限制",
			"field.lifecycle": "生命周期",
			"field.lifecycle.install": "安装可用性",
			"field.lifecycle.configure": "配置可用性",
			"field.lifecycle.update": "更新可用性",
			"field.lifecycle.uninstall": "卸载可用性",
			"field.lifecycle.restore": "还原可用性",
			"field.credentials": "凭据",
			"field.none": "无",
			"field.noneDeclared": "未声明冲突",
			"field.notDeclared": "未声明",
			"publisher.community": "社区目录准入",
			"publisher.registry": "上游 Registry 准入",
			"license.verified": "已在固定 revision 验证",
			"license.declared": "发布者声明",
			"license.unknown": "未知",
			"phase.acquisition": "获取期",
			"phase.runtime": "运行期",
			"dependency.host": "Host 依赖",
			"dependency.runtime": "运行时依赖",
			"dependency.extension": "扩展依赖",
			"dependency.required": "必需",
			"dependency.optional": "可选",
			"credentials.none": "无",
			"credentials.optional": "可选",
			"credentials.required": "必需",
			"verification.verified": "已验证",
			"verification.declared": "发布者声明",
			"verification.unknown": "未知",
			"restart.required": "需要外部重启",
			"restart.notRequired": "未声明需要重启",
			"installed.heading": "受管 Inventory",
			"installed.body": "期望、物料、实际生效、Agent 可见性、验证、回滚与所有权始终是独立事实。",
			"updates.heading": "准确更新",
			"updates.body": "每项更新都是一个已观测且带完整性固定的目标；不会自动选择或应用。",
			"activity.heading": "活动与恢复",
			"activity.body": "已验证的 operation 投影与终态回执独立于恢复动作。",
			"lifecycle.heading": "当前 Host 不支持生命周期操作",
			"lifecycle.body": "可写 P0 需要扩展中心自有的 Plugin、MCP 与续行生命周期，以及官方 Skill、Tool 和 Loader registry。",
			"lifecycle.code": "unavailable(host-capability)",
			"lifecycle.available": "可用",
			"lifecycle.unavailable": "不可用",
			"capability.heading": "可写 Host 预检",
			"capability.managedPluginLifecycle": "受管 Plugin 生命周期",
			"capability.dynamicMcpConnection": "动态 MCP connection",
			"capability.durableContinuation": "Durable continuation",
			"capability.skillRegistry": "Skill registry",
			"capability.toolRegistry": "Tool registry",
			"capability.loaderMutation": "Loader 变更",
			"capability.ready": "就绪",
			"capability.missing": "缺失",
			"action.install": "安装",
			"action.configure": "配置",
			"action.update": "更新",
			"action.enable": "启用",
			"action.disable": "停用",
			"action.uninstall": "卸载",
			"action.restore": "还原",
			"action.recover": "重试准确恢复",
			"action.verify": "验证当前状态",
			"action.purge": "永久清除保留数据",
			"action.retry": "重试预览",
			"action.cancel": "取消",
			"action.noCandidate": "该条目没有绑定已准入候选。",
			"management.unavailable": "管理不可用",
			"management.unavailable.body": "Host 未返回有效管理投影；不会把任何生命周期动作当作成功。",
			"management.retry": "重试管理",
			"inventory.loading": "正在读取归一化 Inventory…",
			"inventory.incomplete": "本次观测不完整，状态与动作可能不是最新。",
			"inventory.empty": "当前作用域没有扩展",
			"inventory.empty.body": "当前 Web Profile Inventory 没有返回受管或外部条目。",
			"inventory.list": "扩展 Inventory",
			"inventory.verify.failed": "Owner 验证失败",
			"inventory.verify.running": "正在验证…",
			"state.desired": "期望状态",
			"state.materialized": "物料状态",
			"state.effective": "实际生效状态",
			"state.visibility": "Agent 可见性",
			"state.verification": "验证级别",
			"state.rollback": "回滚状态",
			"state.ownership": "所有权",
			"state.configuration": "配置 Revision",
			"configure.heading": "暂存配置草稿",
			"configure.body": "保存会创建新的不可变 Configure 计划；丢弃不会向 Host 发起请求。",
			"configure.json": "配置 JSON",
			"configure.save": "保存并审查",
			"configure.discard": "丢弃草稿",
			"configure.invalid": "保存草稿前请输入严格 JSON。",
			"resolverConfig.heading": "能力解析器设置",
			"resolverConfig.body": "仅接受这 10 个整数字段。保存会创建暂存 Configure 计划，Host 将再次验证。",
			"resolverConfig.schema": "强类型 Configure 字段",
			"resolverConfig.integer": "整数",
			"resolverConfig.staleRule": "staleCacheMs 必须大于等于 freshCacheMs。",
			"resolverConfig.invalid": "数值超出准入范围：",
			"skillConfig.heading": "Skill 目标设置",
			"skillConfig.body": "选择此 Skill 的可见位置，以及允许调用它的入口。",
			"skillConfig.projectRoot": "规范项目根目录",
			"skillConfig.projectRoot.body": "输入真实项目目录的绝对路径；Host 会拒绝别名和非规范路径。",
			"skillConfig.modelInvocable": "允许模型调用此 Skill",
			"skillConfig.userInvocable": "允许用户调用此 Skill",
			"mcpConfig.heading": "MCP 连接设置",
			"mcpConfig.body": "选择一个准确的 Host 预配置 stdio 运行时或未认证 HTTPS 连接；不接受 Agent 提供的服务器包或 URL。",
			"mcpConfig.runtimeMissing": "未预配置已准入运行时",
			"mcpConfig.runtimeMissing.body": "商店只管理连接。管理员必须先在 Host allowlist 中预配置准确且完整性固定的运行时。",
			"mcpConfig.runtime": "Host 已预配置运行时",
			"mcpConfig.noArtifactAcquisition": "不下载外部运行时；该计划只管理与准确 Host 预配置运行时绑定的连接。",
			"mcpConfig.connectionId": "连接名称",
			"mcpConfig.executable": "可执行文件",
			"mcpConfig.arguments": "固定参数",
			"mcpConfig.workingDirectory": "工作目录",
			"mcpConfig.none": "无",
			"mcpConfig.origin": "HTTPS 来源",
			"mcpConfig.endpoint": "准确 MCP 端点",
			"mcpConfig.dataEgress": "发送到该来源的数据",
			"mcpConfig.httpPolicy": "未认证；不允许自定义请求头或凭据；重定向将失败关闭。",
			"mcpConfig.roots": "允许的文件系统根目录",
			"mcpConfig.roots.body": "每行一个规范绝对目录；Agent 不会替用户选择这些根目录。",
			"mcpConfig.timeout": "工具调用超时（毫秒）",
			"mcpConfig.reconnect": "自动重连",
			"mcpConfig.initialDelay": "初始延迟（毫秒）",
			"mcpConfig.maxDelay": "最大延迟（毫秒）",
			"mcpConfig.maxAttempts": "最大尝试次数",
			"mcpConfig.selected": "所选准入项",
			"updates.loading": "正在检查准确更新观测…",
			"updates.empty": "未观测到准确更新",
			"updates.empty.body": "未知或浮动目标不会显示为可用更新。",
			"updates.list": "可用的准确更新",
			"updates.candidate": "已准入候选",
			"updates.exactTarget": "准确目标",
			"activity.loading": "正在验证 operation 与回执…",
			"activity.empty": "尚未运行生命周期操作",
			"activity.empty.body": "读取目录和预览计划都不会创建生命周期回执。",
			"activity.list": "生命周期 Operation",
			"taskAttempt.heading": "原始任务尝试",
			"taskAttempt.body": "任务进度与结果独立于扩展操作。选择候选与“重试原始任务”始终创建新的任务尝试。",
			"taskAttempt.empty": "尚未记录能力任务尝试。",
			"taskAttempt.id": "任务尝试",
			"taskAttempt.phase": "当前阶段",
			"taskAttempt.outcome": "终态结果",
			"taskAttempt.active": "该任务尝试仍在进行。",
			"taskAttempt.parent": "上一次尝试",
			"taskAttempt.choice": "选择一个已准入候选；该选择不会批准能力获取。",
			"taskAttempt.select": "选择",
			"taskAttempt.management": "请先在扩展中心完成此动作，再重试：",
			"taskAttempt.extensionRef": "不透明扩展引用",
			"taskAttempt.retryOriginal": "重试原始任务",
			"taskAttempt.candidate": "等待常规获取请求或审批流程的候选",
			"taskAttempt.cancel": "取消任务尝试",
			"taskAttempt.cancelContinuation": "取消续跑",
			"taskAttempt.derived": "已从该终态结果创建新的任务尝试。",
			"taskAttempt.retryContinuation": "原始任务续跑：",
			"taskAttempt.retryContinuation.pending": "等待能力验证",
			"taskAttempt.retryContinuation.ready": "已验证并排队续跑",
			"taskAttempt.retryContinuation.consumed": "已验证，等待调度所有者",
			"taskAttempt.retryContinuation.dispatching": "带栅栏的所有者正在调度续跑",
			"taskAttempt.retryContinuation.dispatched": "续跑消息已持久化排队",
			"taskAttempt.retryContinuation.claimed": "Agent 已领取续跑",
			"taskAttempt.retryContinuation.deliveryUnknown": "投递结果未知，已阻止自动重试",
			"taskAttempt.retryContinuation.canceled": "续跑已取消",
			"taskAttempt.retryContinuation.superseded": "续跑已被更新的任务尝试取代",
			"taskAttempt.retryContinuation.expired": "续跑已过期",
			"taskAttempt.retryContinuation.invalid": "续跑无效，不会执行",
			"taskAttempt.retryContinuation.reconciling": "续跑声明等待 Host 对账",
			"taskAttempt.retryContinuation.unavailable": "当前 Host 无法读取续跑状态",
			"approval.heading": "任务能力获取审批",
			"approval.body": "这些准确计划来自 Agent 的能力缺口识别；在你批准某个哈希前不会执行变更。",
			"approval.empty": "当前没有待审查的任务计划。",
			"approval.review": "审查任务计划",
			"approval.configuration.heading": "任务配置请求",
			"approval.configuration.body": "Agent 找到了已准入候选，但不能替你选择文件系统目录或 Host 运行时。完成配置前不会生成计划。",
			"approval.configuration.empty": "没有等待配置的任务候选。",
			"approval.configuration.required": "需要配置",
			"approval.configuration.open": "配置任务候选",
			"approval.configuration.saving": "正在创建准确任务计划…",
			"operation.id": "Operation",
			"operation.phase": "阶段",
			"operation.updated": "最后 Journal 事件",
			"operation.started": "生命周期操作已结束",
			"operation.restartRequired": "需要外部重启",
			"operation.uncertain": "决策结果需要核对",
			"operation.uncertain.body": "不要再次提交授权；请关闭审查并到“活动与恢复”核对。",
			"operation.notRecorded": "Host 已证明该计划仍处于待决定状态；你可以重新作出一次明确决定。",
			"operation.resume": "继续已批准计划",
			"operation.resuming": "正在继续已批准计划…",
			"receipt.pending": "尚未签发终态回执。",
			"receipt.outcome": "回执结果",
			"receipt.source": "来源",
			"receipt.version": "版本",
			"receipt.integrity": "完整性",
			"receipt.scope": "作用域 / Profile",
			"receipt.configuration": "配置 Digest",
			"receipt.authority": "权限 Digest",
			"receipt.retention": "保留数据披露 Digest",
			"receipt.mutation": "变更证据",
			"receipt.verification": "验证证据",
			"receipt.rollback": "回滚证据",
			"receipt.restart": "重启证据",
			"receipt.recovery": "恢复证据",
			"receipt.notProven": "未证明",
			"receipt.digest": "回执 Digest",
			"receipt.journal": "Journal 证据",
			"review.heading": "准确审查证据",
			"review.body": "这些不含秘密的事实已绑定进不可变计划哈希和终态收据。",
			"review.checks": "计划执行的检查",
			"review.checksRun": "实际完成的检查",
			"review.removed": "将移除的物料",
			"review.retained": "将保留的物料",
			"review.credentials": "凭据处理选择",
			"review.rollback": "固定回滚点",
			"review.limits": "回滚限制",
			"review.notProven": "仍未证明",
			"review.plugin": "Plugin package、中心自有物料、Loader 激活、脚本与设置",
			"review.skill": "完整 Skill 文件、正文、链接、可执行位与调用策略",
			"review.mcp": "准确 MCP descriptor、runtime、凭据与数据外发",
			"recovery.required": "需要恢复",
			"recovery.required.body": "此前操作未能完成受约束的回滚。只重试这个已锁定操作，不授予新权限。",
			"recovery.running": "正在重试准确恢复…",
			"recovery.command": "独立恢复 argv",
			"recovery.reconciliationPending": "Profile 恢复可能先于中心 journal 对账完成；journal reconciliation pending。",
			"recovery.retiredRuntime": "此操作因其绑定的私有 pnpm 运行时已出于安全原因退役而被隔离。旧运行时不会执行；目标会保持锁定，等待当前版本的恢复路径。",
			"plan.loading": "正在生成不可变预览…",
			"plan.unavailable": "计划预览不可用",
			"plan.unavailable.body": "Host 返回一个有效准确计划前，不能做出决策。",
			"plan.eyebrow": "尚未授权任何变更",
			"plan.heading": "审查准确生命周期计划",
			"plan.body": "批准或拒绝当前唯一哈希；批准仅可使用一次，不能用于其他操作、作用域或版本。",
			"plan.close": "关闭计划审查",
			"plan.denied": "Policy 已拒绝该计划",
			"plan.candidateUnavailable": "准确候选披露不可用",
			"plan.candidateUnavailable.body": "目录条目与当前计划的版本或完整性不一致；已禁用批准，拒绝仍是安全操作。",
			"plan.expired": "计划已过期",
			"plan.expired.body": "该哈希已超出授权时间窗；请关闭并创建新的预览。",
			"plan.operation": "操作",
			"plan.candidate": "候选引用",
			"plan.target": "受管目标",
			"plan.scope": "作用域 / Profile",
			"plan.desired": "期望状态",
			"plan.managedObject": "受管对象",
			"plan.externalRuntimeAction": "外部运行时动作",
			"plan.runtimeRef": "绑定运行时引用",
			"plan.runtimeVersion": "绑定运行时版本",
			"plan.runtimeDescriptorDigest": "运行时描述符 Digest",
			"plan.authorityDigest": "权限 Digest",
			"plan.mutationDigest": "变更 Digest",
			"plan.verificationDigest": "验证 Digest",
			"plan.configurationDiff": "暂存配置 Diff",
			"plan.configurationDigest": "配置 Digest",
			"plan.digesting": "正在计算 Digest…",
			"plan.digestUnavailable": "Digest 不可用",
			"plan.hash": "计划哈希",
			"plan.expires": "过期时间",
			"plan.singleUse": "授权",
			"plan.singleUse.yes": "一次准确决策；仅可使用一次",
			"plan.decision": "人工计划决策",
			"plan.reject": "拒绝计划",
			"plan.rejecting": "正在拒绝…",
			"plan.approve": "批准准确计划",
			"plan.approving": "正在批准…",
			"plan.rejected": "计划已拒绝",
			"plan.rejected.body": "未发送生命周期请求，且该计划之后不能再被批准。"
		};
		//#endregion
		//#region lib/.build/client/store.js
		/** Return whether a transient update retained the exact visible state. */
		function sameState(left, right) {
			return left.open === right.open && left.active === right.active;
		}
		/** Create one framework-neutral store instance from the shared declaration. */
		function createStoreInstance(spec) {
			let state = spec.init();
			const listeners = /* @__PURE__ */ new Set();
			const update = (mutate) => {
				const next = { ...state };
				mutate(next);
				if (sameState(state, next)) return;
				state = next;
				for (const listener of [...listeners]) try {
					listener();
				} catch (error) {
					console.error("extension-center store subscriber failed:", error);
				}
			};
			return {
				actions: {
					openStore: () => {
						update(spec.actions.openStore);
					},
					close: () => {
						update(spec.actions.close);
					},
					select: (view) => {
						update((draft) => {
							spec.actions.select(draft, view);
						});
					}
				},
				getSnapshot: () => state,
				subscribe(listener) {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				clearPersisted() {}
			};
		}
		/**
		* Create one transient root store for the two Extension Center entries.
		* @returns A fresh handle owned by one Client plugin application.
		*/
		function createExtensionCenterStore() {
			const spec = {
				init: () => ({
					open: false,
					active: "store"
				}),
				actions: {
					openStore: (draft) => {
						draft.active = "store";
						draft.open = true;
					},
					close: (draft) => {
						draft.open = false;
					},
					select: (draft, view) => {
						draft.active = view;
					}
				}
			};
			return {
				spec,
				create: () => createStoreInstance(spec)
			};
		}
		//#endregion
		//#region lib/.build/client/index.js
		/** Required browser services. */
		const inject = [
			"connection",
			"slots",
			"locale"
		];
		/** Register bilingual copy, effect-owned styles, and the two additive shell entries. */
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(EXTENSION_CENTER_LOCALE, {
				zh,
				en
			}), "extension-center: dictionaries");
			ctx.effect(() => {
				if (document.querySelector(`style[data-plugin-css="dsh-plugin-extension-center/ExtensionCenter.module.css"]`) !== null) throw new Error(`extension-center style already installed: ${styleTagId}`);
				const style = document.createElement("style");
				style.dataset.plugin = "dsh-plugin-extension-center";
				style.dataset.pluginCss = styleTagId;
				style.textContent = cssText;
				document.head.appendChild(style);
				return () => {
					style.remove();
				};
			}, "extension-center: styles");
			const store = createExtensionCenterStore();
			const connection = ctx.get("connection");
			const BoundExtensionCenterOverlay = bindExtensionCenterOverlay(createExtensionCatalogClient(connection.rpc), createExtensionManagementClient(connection.rpc), {
				profileId: "web",
				defaultScopeKey: "profile:web"
			});
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.inject("shell.overlay", () => [ctx.slots.register({
				name: "sidebar.footer.action",
				id: "extension-center",
				order: 0,
				locale: EXTENSION_CENTER_LOCALE,
				store
			}, ExtensionCenterTrigger), ctx.slots.register({
				name: "shell.overlay",
				id: "extension-center",
				order: 0,
				locale: EXTENSION_CENTER_LOCALE,
				store
			}, BoundExtensionCenterOverlay)]));
		}
		//#endregion
		exports.ExtensionCenterOverlay = ExtensionCenterOverlay;
		exports.ExtensionCenterTrigger = ExtensionCenterTrigger;
		exports.apply = apply;
		exports.createExtensionCatalogClient = createExtensionCatalogClient;
		exports.createExtensionCenterStore = createExtensionCenterStore;
		exports.createExtensionManagementClient = createExtensionManagementClient;
		exports.inject = inject;
		exports.parseCatalogListResponse = parseCatalogListResponse;
		exports.parseConfigurationDraft = parseConfigurationDraft;
		exports.parseIntentPreviewResponse = parseIntentPreviewResponse;
		exports.parseInventoryListResponse = parseInventoryListResponse;
		exports.parseOperationListResponse = parseOperationListResponse;
		exports.parseOperationReceiptsResponse = parseOperationReceiptsResponse;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map
