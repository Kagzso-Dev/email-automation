import { AutomationGate } from "../components/automation/AutomationPage";

// LinkedIn Automation (ENABLE_AUTOMATION): LinkedIn Ads campaigns. Flag off / not admin or editor → Dashboard.
export function LinkedInAutomationPage() {
  return <AutomationGate platform="linkedin" />;
}
