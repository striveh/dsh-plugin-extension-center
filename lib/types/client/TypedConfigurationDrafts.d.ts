import type { ConfigurationRuntimeOption, RpcJson } from '../service/rpc-contract.ts';
import type { ExtensionCenterKey } from './locales.ts';
type Translate = (key: ExtensionCenterKey) => string;
/** Typed Skill target and invocation configuration. */
export declare function SkillConfigurationDraft({ scopeKey, initial, t, onSave, onDiscard }: {
    readonly scopeKey: string;
    readonly initial: RpcJson | null;
    readonly t: Translate;
    readonly onSave: (configuration: RpcJson) => void;
    readonly onDiscard: () => void;
}): import("react").JSX.Element;
/** Typed MCP connection over one Host-provisioned runtime selector. */
export declare function McpConfigurationDraft({ options, initial, t, onSave, onDiscard }: {
    readonly options: readonly ConfigurationRuntimeOption[];
    readonly initial: RpcJson | null;
    readonly t: Translate;
    readonly onSave: (configuration: RpcJson) => void;
    readonly onDiscard: () => void;
}): import("react").JSX.Element;
export {};
//# sourceMappingURL=TypedConfigurationDrafts.d.ts.map
