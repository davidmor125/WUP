import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { useApi } from './hooks/useApi';
import ConnectPage from './pages/ConnectPage.jsx';
import ChatsPage from './pages/ChatsPage.jsx';
import WebhooksPage from './pages/WebhooksPage.jsx';
import StatusDot from './components/StatusDot.jsx';

const NAV = [
  { to: '/connect', label: 'Connect' },
  { to: '/chats', label: 'Chats' },
  { to: '/webhooks', label: 'Webhooks' },
];

export default function App() {
  const { data } = useApi('/whatsapp/status', { interval: 10000 });
  const status = data?.data?.status || 'disconnected';
  const phone = data?.data?.phoneNumber;

  return (
    <div className="min-h-full flex flex-col">
      <header className="bg-surface border-b border-border">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center gap-6">
          <span className="font-semibold tracking-tight">WUP</span>

          <nav className="flex items-center gap-1">
            {NAV.map(({ to, label }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `px-3 py-1.5 text-sm rounded-md transition-colors ${
                    isActive ? 'bg-accent/10 text-accent-dark font-medium' : 'text-muted hover:text-text'
                  }`
                }
              >
                {label}
              </NavLink>
            ))}
          </nav>

          <div className="ml-auto flex items-center gap-2 text-sm">
            <StatusDot status={status} />
            <span className="text-muted">{phone ? `+${phone}` : status}</span>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-6xl w-full mx-auto px-6 py-6">
        <Routes>
          <Route path="/" element={<Navigate to="/connect" replace />} />
          <Route path="/connect" element={<ConnectPage />} />
          {/* Contacts and conversations are one screen — /contacts kept as an alias. */}
          <Route path="/contacts" element={<Navigate to="/chats" replace />} />
          <Route path="/chats" element={<ChatsPage />} />
          <Route path="/webhooks" element={<WebhooksPage />} />
          <Route path="*" element={<Navigate to="/connect" replace />} />
        </Routes>
      </main>
    </div>
  );
}
