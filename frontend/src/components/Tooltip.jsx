export default function Tooltip({ text, children, side = 'top' }) {
  return (
    <span className="tooltip-wrap">
      {children}
      <span className="tooltip-bubble">{text}</span>
    </span>
  );
}
