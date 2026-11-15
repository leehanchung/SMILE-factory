import type { ReactNode } from "react";

export function ToggleRow(props: {
  label: string;
  desc?: ReactNode;
  on: boolean;
  disabled?: boolean;
  onToggle: () => void;
}) {
  const { label, desc, on, disabled, onToggle } = props;
  return (
    <div className="settings__item">
      <div>
        <div className="settings__k">{label}</div>
        {desc ? <div className="settings__kk">{desc}</div> : null}
      </div>
      <button
        type="button"
        className={`toggle${on ? " toggle--on" : ""}`}
        role="switch"
        aria-checked={on}
        aria-label={label}
        disabled={disabled}
        onClick={onToggle}
      />
    </div>
  );
}
