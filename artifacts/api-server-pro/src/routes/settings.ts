import { Router, type IRouter } from "express";
import { readSettings, writeSettings } from "../lib/settings";

const router: IRouter = Router();

router.get("/settings", (_req, res): void => {
  res.json(readSettings());
});

router.put("/settings", (req, res): void => {
  const body = req.body as Record<string, unknown>;

  if (typeof body.channelHandle !== "string") {
    res.status(400).json({ error: "channelHandle must be a string" });
    return;
  }

  const updated = writeSettings({ channelHandle: body.channelHandle });
  res.json(updated);
});

export default router;
