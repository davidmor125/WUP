const COLORS = {
  ready: 'bg-green-500',
  authenticated: 'bg-green-400',
  qr_pending: 'bg-amber-400',
  initializing: 'bg-amber-400',
  disconnected: 'bg-zinc-300',
};

export default function StatusDot({ status }) {
  const color = COLORS[status] || COLORS.disconnected;
  const pulsing = status === 'qr_pending' || status === 'initializing';

  return (
    <span className="relative inline-flex w-2.5 h-2.5" title={status}>
      {pulsing && (
        <span className={`absolute inline-flex w-full h-full rounded-full opacity-60 animate-ping ${color}`} />
      )}
      <span className={`relative inline-flex w-2.5 h-2.5 rounded-full ${color}`} />
    </span>
  );
}
