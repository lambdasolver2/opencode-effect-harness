import { Schema } from 'effect';

export namespace Message {
	export const Delivery = Schema.Literals([
		'steer',
		'followUp',
		'nextTurn'
	] as const);

	export class Value extends Schema.Class<Value>('UserMessage')({
		content: Schema.String,
		deliverAs: Schema.optionalKey(Delivery)
	}) {}

	export const isEmpty = (message: Message.Value): boolean =>
		message.content.trim().length === 0;

	export const normalized = (message: Message.Value): string =>
		message.content.replace(/\s+/g, ' ').trim();
}
