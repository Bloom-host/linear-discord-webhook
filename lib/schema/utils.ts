import { z } from 'zod';

export enum Action {
	CREATE = 'create',
	UPDATE = 'update',
	REMOVE = 'remove'
}

export enum Model {
	ISSUE = 'Issue',
	COMMENT = 'Comment',
	PROJECT_UPDATE = 'ProjectUpdate'
}

export const DATE_RESOLVABLE = z
	.date()
	.or(z.string())
	.transform((arg) => new Date(arg));

export function createModelSchema<
	T extends Model,
	C extends z.ZodObject<z.ZodRawShape>
>(type: T, commons: C) {
	return z.object({
		type: z.literal(type),
		data: commons,
		updatedFrom: z.object({ stateId: z.string().uuid().optional() }).optional()
	});
}
