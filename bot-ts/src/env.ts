import { config } from "dotenv";

// Local development can reuse the existing Python bot credentials without copying
// secrets into source control. Vercel deployments use their configured env vars.
config({ path: [".env", "../bot/.env"] });
