import { createApp } from "../src/app.js";
import { assertStartupEnv } from "../src/config/env.js";

assertStartupEnv();

const app = createApp();

export default app;
