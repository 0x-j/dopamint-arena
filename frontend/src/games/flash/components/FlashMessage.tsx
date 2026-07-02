export interface FlashMessageProps {
  sender: string; // display label, e.g. "A", "B", "You"
  text: string;
  isMe: boolean;
}

export function FlashMessage({ sender, text, isMe }: FlashMessageProps) {
  return (
    <div className={`flash-row${isMe ? " b" : ""}`}>
      <div className="flash-bubble">
        <div className="flash-bubble__sender">{sender}</div>
        <div>{text}</div>
      </div>
    </div>
  );
}
