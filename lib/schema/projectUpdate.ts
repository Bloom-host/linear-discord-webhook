import { z } from 'zod';
import { createModelSchema, Model } from './utils';

const COMMONS = z.object({
	id: z.string().uuid(),
	body: z.string(),
	health: z.enum(['onTrack', 'atRisk', 'offTrack']).optional(),
	project: z.object({
		id: z.string().uuid(),
		name: z.string(),
		url: z.string().url()
	}),
	user: z.object({
		id: z.string().uuid(),
		name: z.string(),
		avatarUrl: z.string().url().optional()
	})
});

export const PROJECT_UPDATE_SCHEMA = createModelSchema(
	Model.PROJECT_UPDATE,
	COMMONS
);
