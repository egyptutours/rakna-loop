import { route } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { getContext } from "@/lib/data";
import { cancelBooking } from "@/lib/domain/marketplace";

export const dynamic = "force-dynamic";

export const DELETE = route(async (_req: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { id } = await params;
  const user = await requireRole(["driver"]);
  return { booking: await cancelBooking(getContext(), user.id, id) };
});
