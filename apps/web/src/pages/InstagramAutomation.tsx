import { AutomationGate } from "../components/automation/AutomationPage";

// Instagram Automation (ENABLE_AUTOMATION): Instagram Ads campaigns + Instagram DMs. Flag off / not admin or editor → Dashboard.
export function InstagramAutomationPage() {
  return <AutomationGate platform="instagram" />;
}
