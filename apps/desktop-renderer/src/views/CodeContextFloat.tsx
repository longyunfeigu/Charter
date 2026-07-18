import React from 'react';

/**
 * The floating "添加到上下文" selection action, 1:1 with the approved mock
 * (docs/design/code-context-ref-mockups, shared.css `.selection-action`):
 * a dark anchored bubble with a down-pointing caret and a cream attach
 * button. Each code surface owns the positioning (absolute inside its own
 * frame); this component only renders the bubble itself.
 */
export const CodeContextFloat = React.forwardRef<
  HTMLDivElement,
  {
    label: string;
    testid: string;
    buttonTestid: string;
    style?: React.CSSProperties;
    onAttach: () => void;
  }
>(function CodeContextFloat(props, ref) {
  return (
    <div ref={ref} className="code-context-float" style={props.style} data-testid={props.testid}>
      <span>{props.label}</span>
      <button
        type="button"
        data-testid={props.buttonTestid}
        // Keep the source selection alive while the pointer presses the button.
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onAttach}
      >
        添加到上下文
      </button>
    </div>
  );
});

export function codeContextFloatRange(startLine: number, endLine: number): string {
  return endLine === startLine ? `L${startLine}` : `L${startLine}–${endLine}`;
}
