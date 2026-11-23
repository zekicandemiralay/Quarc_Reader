import { useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import useAuthStore from './store/authStore';
import useSettings, { applyTheme } from './store/settingsStore';
import { startSyncLoop } from './lib/sync';
import Toasts from './components/Toasts';
import Login from './pages/Login/Login';
import Library from './pages/Library/Library';
import Reader from './pages/Reader/Reader';
import Settings from './pages/Settings/Settings';
import SharedView from './pages/Shared/SharedView';

function Splash() {
  return (
    <div className="flex h-full items-center justify-center bg-white dark:bg-neutral-900">
      <img src="/logo.png" alt="" className="h-14 w-14 animate-pulse rounded-2xl" />
    </div>
  );
}

function ProtectedRoute({ children }) {
  const { user, loading } = useAuthStore();
  if (loading && !user) return <Splash />;
  if (!user) return <Navigate to="/login" replace />;
  return children;
}

export default function App() {
  const checkSession = useAuthStore((s) => s.checkSession);
  const user = useAuthStore((s) => s.user);
  const theme = useSettings((s) => s.theme);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    checkSession();
  }, [checkSession]);

  // Keep the library in step with the server — for the documents the user
  // chose to sync. Everything works offline; this just catches up when it can.
  useEffect(() => {
    if (!user?.id) return undefined;
    return startSyncLoop(user.id);
  }, [user?.id]);

  return (
    <>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/s/:token" element={<SharedView />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Library />
            </ProtectedRoute>
          }
        />
        <Route
          path="/read/:id"
          element={
            <ProtectedRoute>
              <Reader />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <Settings />
            </ProtectedRoute>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toasts />
    </>
  );
}
