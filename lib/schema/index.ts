import { z } from 'zod';
import { COMMENT_SCHEMA } from './comment';
import { ISSUE_SCHEMA } from './issue';
import { PROJECT_UPDATE_SCHEMA } from './projectUpdate';
import { Action, DATE_RESOLVABLE } from './utils';

const COMMONS = z.object({
	action: z.enum([Action.CREATE, Action.UPDATE, Action.REMOVE]),
	createdAt: DATE_RESOLVABLE,
	url: z.string().url()
});

export const SCHEMA = COMMONS.and(
	ISSUE_SCHEMA.or(COMMENT_SCHEMA).or(PROJECT_UPDATE_SCHEMA)
);
