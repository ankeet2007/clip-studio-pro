import { Router, type IRouter } from "express";
import healthRouter from "./health";
import clipsRouter from "./clips";
import authRouter from "./auth";
import settingsRouter from "./settings";
const router: IRouter = Router();

router.use(healthRouter);
router.use(clipsRouter);
router.use("/auth/youtube", authRouter);
router.use(settingsRouter);

export default router;
