import express from "express";
import { authorizeRole } from "../middleware/authorize.js";
import { validate } from "../middleware/validate.js";
import {
  marketingAudienceSchema,
  marketingCampaignSchema,
  marketingConsentSchema,
  marketingLaunchSchema
} from "../validators/schemas.js";

export function marketingRoutes(controller) {
  const router = express.Router();
  router.use(authorizeRole("OWNER", "ADMIN"));
  router.get("/templates", controller.templates);
  router.patch("/contacts/:contactId/consent", validate(marketingConsentSchema), controller.consent);
  router.get("/audiences", controller.listAudiences);
  router.post("/audiences", validate(marketingAudienceSchema), controller.createAudience);
  router.get("/audiences/:audienceId", controller.getAudience);
  router.patch("/audiences/:audienceId", validate(marketingAudienceSchema.partial()), controller.updateAudience);
  router.get("/campaigns", controller.listCampaigns);
  router.post("/campaigns", validate(marketingCampaignSchema), controller.createCampaign);
  router.get("/campaigns/:campaignId", controller.getCampaign);
  router.post("/campaigns/:campaignId/launch", validate(marketingLaunchSchema), controller.launchCampaign);
  router.post("/campaigns/:campaignId/pause", controller.pauseCampaign);
  router.post("/campaigns/:campaignId/resume", controller.resumeCampaign);
  return router;
}
