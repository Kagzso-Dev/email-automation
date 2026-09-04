import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { InsightsPage } from "./pages/Insights";
import { ContactsPage } from "./pages/Contacts";
import { WhatsAppContactsPage } from "./pages/WhatsAppContacts";
import { WhatsAppTemplatesPage } from "./pages/WhatsAppTemplates";
import { ListsPage } from "./pages/Lists";
import { ListDetailPage } from "./pages/ListDetail";
import { TemplatesPage } from "./pages/Templates";
import { CampaignsPage } from "./pages/Campaigns";
import { CampaignDetailPage } from "./pages/CampaignDetail";
import { SendQueuePage } from "./pages/SendQueue";
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
        <Route path="/insights" element={<InsightsPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/whatsapp-contacts" element={<WhatsAppContactsPage />} />
        <Route path="/whatsapp-templates" element={<WhatsAppTemplatesPage />} />
        <Route path="/lists" element={<ListsPage />} />
        <Route path="/lists/:id" element={<ListDetailPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/campaigns" element={<CampaignsPage />} />
        <Route path="/campaigns/:id" element={<CampaignDetailPage />} />
        <Route path="/send-queue" element={<SendQueuePage />} />
        <Route path="/triggers" element={<TriggersPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
