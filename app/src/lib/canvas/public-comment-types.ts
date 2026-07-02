// Wire shape shared between the public comments read route
// (/api/public/deck/{token}/comments) and the viewer's comment sheet.
// Only client-rooted threads plus the team's replies ever cross this
// boundary — see the partition note in the route.

export type PublicCommentReply = {
  id: string;
  author: string;
  body: string;
  created_at: string;
};

export type PublicCommentThread = {
  id: string;
  slide_id: string | null;
  author: string;
  body: string;
  resolved: boolean;
  created_at: string;
  replies: PublicCommentReply[];
};
