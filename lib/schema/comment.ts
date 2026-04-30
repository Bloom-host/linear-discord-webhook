import { z } from 'zod';
import { createModelSchema, Model } from './utils';

// Linear sends `type: "Comment"` for two distinct parent shapes:
// - Comments on issues:           data.issue is present
// - Comments on project updates:  data.projectUpdate is present (no issue)
// They share an event type, but discriminate by the *presence* of the parent
// field (no literal tag), so we use z.union rather than z.discriminatedUnion.
// `.loose()` keeps unknown Linear-side fields from breaking parsing.

const COMMENT_BASE = z.object({
	id: z.string().uuid(),
	body: z.string(),
	userId: z.string().uuid()
});

const ISSUE_COMMENT = COMMENT_BASE.extend({
	issue: z.object({ title: z.string() }).loose()
}).loose();

const PROJECT_UPDATE_COMMENT = COMMENT_BASE.extend({
	projectUpdate: z
		.object({
			project: z.object({ name: z.string() }).loose()
		})
		.loose()
}).loose();

export type IssueComment = z.infer<typeof ISSUE_COMMENT>;
export type ProjectUpdateComment = z.infer<typeof PROJECT_UPDATE_COMMENT>;

// `z.union` tries variants in order: an issue-comment with a stray
// `projectUpdate` field would still classify as an issue comment.
export const COMMENT_SCHEMA = createModelSchema(
	Model.COMMENT,
	z.union([ISSUE_COMMENT, PROJECT_UPDATE_COMMENT])
);

// `.loose()` adds a `[k: string]: unknown` index signature, which prevents
// `'issue' in data` from narrowing the union at the type level. Use this
// guard wherever the handler needs to branch on parent shape.
export function isIssueComment(
	data: IssueComment | ProjectUpdateComment
): data is IssueComment {
	return 'issue' in data && data.issue != null;
}
