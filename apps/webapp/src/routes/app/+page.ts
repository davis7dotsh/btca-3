import { redirect } from "@sveltejs/kit";
import type { PageLoad } from "./$types";

export const load: PageLoad = ({ url }) => {
  const threadId = url.searchParams.get("thread");

  if (threadId) {
    throw redirect(307, `/app/chat/${encodeURIComponent(threadId)}`);
  }

  throw redirect(307, "/app/chat");
};
