import { withWorkflow } from "workflow/next";
import type { NextConfig } from "next";

// API-only server: no UI pages. Route handlers live under src/app/api.
const nextConfig: NextConfig = {
  serverExternalPackages: ["pg", "apns2"],
};

export default withWorkflow(nextConfig);
