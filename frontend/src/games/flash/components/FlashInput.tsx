export interface FlashInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  sendDisabled?: boolean;
}

export function FlashInput({
  value,
  onChange,
  onSend,
  sendDisabled,
}: FlashInputProps) {
  const canSend = !sendDisabled && value.trim().length > 0;
  return (
    <div className="flash-foot">
      <input
        className="flash-input"
        value={value}
        placeholder="type a message…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && canSend) onSend();
        }}
      />
      <button className="flash-btn" disabled={!canSend} onClick={onSend}>
        send
      </button>
    </div>
  );
}
