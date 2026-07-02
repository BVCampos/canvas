import { redirect } from "next/navigation";

// /settings has no content of its own — land on the first section every role
// can see (Account), so "Settings" links in the user menu always resolve.
export default function SettingsIndexPage() {
  redirect("/settings/account");
}
