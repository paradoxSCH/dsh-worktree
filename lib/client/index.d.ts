import React from 'react';
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client';
declare function WorktreeDashboard({ close }: {
    close: () => void;
}): React.DetailedReactHTMLElement<{
    style: React.CSSProperties;
    role: "dialog";
    'aria-modal': true;
}, HTMLElement>;
declare function WorktreeFooter({ wide }: {
    wide: boolean;
}): React.FunctionComponentElement<{
    children?: React.ReactNode | undefined;
}>;
export declare const inject: string[];
export declare function apply(ctx: ClientContext): void;
export { WorktreeDashboard, WorktreeFooter };
//# sourceMappingURL=index.d.ts.map