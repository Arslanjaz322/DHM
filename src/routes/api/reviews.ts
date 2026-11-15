import { createFileRoute } from "@tanstack/react-router";

// Visitor reviews: public read + submit; hide / show / delete need the admin key (when ADMIN_KEY is set).
export const Route = createFileRoute("/api/reviews")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const { reviewsGET } = await import("@/lib/backend/reviews.server");
        return reviewsGET(request);
      },
      POST: async ({ request }) => {
        const { reviewsPOST } = await import("@/lib/backend/reviews.server");
        return reviewsPOST(request);
      },
    },
  },
});
