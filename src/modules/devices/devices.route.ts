import { Router, Request, Response, NextFunction } from "express";
import { z } from "zod";
import prisma from "../../prisma/client";
import { verifyTokenMiddleware } from "../../middleware/auth.middleware";

/** Mobile app installs register their Expo push token here (any role). */
const registerSchema = z.object({
  token: z.string().regex(/^Expo(nent)?PushToken\[.+\]$/, "invalid Expo push token"),
  platform: z.enum(["android", "ios"]),
});
const removeSchema = z.object({ token: z.string().min(1) });

const router = Router();
router.use(verifyTokenMiddleware);

router.post("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, platform } = registerSchema.parse(req.body);
    // A device that switches account moves to the new user.
    await prisma.deviceToken.upsert({
      where: { token },
      create: { token, platform, user_id: req.user!.user_id },
      update: { platform, user_id: req.user!.user_id, last_seen_at: new Date() },
    });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.delete("/", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = removeSchema.parse(req.body ?? {});
    await prisma.deviceToken.deleteMany({ where: { token, user_id: req.user!.user_id } });
    res.status(204).end();
  } catch (err) {
    next(err);
  }
});

export default router;
