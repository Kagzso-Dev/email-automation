import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { ContactsPage } from "./pages/Contacts";
import { ListsPage } from "./pages/Lists";
import { TemplatesPage } from "./pages/Templates";
import { CampaignsPage } from "./pages/Campaigns";
import { CampaignDetailPage } from "./pages/CampaignDetail";
import { TriggersPage } from "./pages/Triggers";
import { SettingsPage } from "./pages/Settings";

export function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return <div className="grid min-h-screen place-items-center text-sm text-slate-550">Loading…</div>;
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/lists" element={<ListsPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
        <Route path="/triggers" element={<TriggersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
