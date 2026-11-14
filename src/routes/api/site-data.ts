import { createFileRoute } from "@tanstack/react-router";

// Website content + admin sign-in, team, activity log and backups.
// Admin actions need the X-Admin-Token header to match the ADMIN_KEY secret (when it is set).
export const Route = createFileRoute("/api/site-data")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { siteDataGET } = await import("@/lib/backend/site-data.server");
        return siteDataGET(request);
      },
      POST: async ({ request }) => {
        const { siteDataPOST } = await import("@/lib/backend/site-data.server");
        return siteDataPOST(request);
      },
    },
  },
});
