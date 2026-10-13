import type { ZohoMapping } from '@/lib/types';

export interface MappingField {
  key: keyof ZohoMapping;
  label: string;
  hint: string;
  list?: boolean;
  required?: boolean;
}

export const MAPPING_FIELDS: MappingField[] = [
  { key: 'dealId', label: 'Deal ID field', hint: 'A value that is unique per sale. It also stops a sale being counted twice.', required: true },
  { key: 'amount', label: 'Amount field', hint: 'The sale value.', required: true },
  { key: 'occurredAt', label: 'Sale date field', hint: 'A date or date-time. Date-only values count as noon.', required: true },
  { key: 'phone', label: 'Phone field', hint: 'On the Zoho contact this is often Contact_Name.Mobile.', required: true },
  { key: 'channel', label: 'Sales channel field', hint: 'Tells in-store sales from online ones.', required: true },
  { key: 'storeChannelValues', label: 'Values that mean “in store”', hint: 'Comma separated', list: true, required: true },
  { key: 'email', label: 'Email field', hint: 'Optional but improves matching.' },
  { key: 'firstName', label: 'First name field', hint: 'Optional. Name, place and customer ID help the ad platforms recognise the buyer.' },
  { key: 'lastName', label: 'Last name field', hint: 'Optional.' },
  { key: 'city', label: 'City field', hint: 'Optional.' },
  { key: 'state', label: 'State field', hint: 'Optional. Names such as Maharashtra are sent as the code (MH).' },
  { key: 'postalCode', label: 'Postal code field', hint: 'Optional.' },
  { key: 'country', label: 'Country field', hint: 'Optional but needed for Google to use the address. Not guessed from the phone number.' },
  { key: 'customerId', label: 'Customer ID field', hint: 'Optional. The contact’s own ID in Zoho, for example Contact_Name.id.' },
  { key: 'stage', label: 'Stage field', hint: 'Leave empty to treat every record as won.' },
  { key: 'wonStages', label: 'Won stage values', hint: 'Comma separated, for example Closed Won', list: true },
  { key: 'fallbackOccurredAt', label: 'Sale date fallback', hint: 'Used when the main date is empty.' },
  { key: 'store', label: 'Store field', hint: 'Shown next to each sale.' },
  { key: 'whatsappChannelValues', label: 'Values that mean “WhatsApp”', hint: 'Comma separated', list: true },
  { key: 'onlineChannelValues', label: 'Values that mean “online”', hint: 'Comma separated', list: true },
  { key: 'consent', label: 'Consent field', hint: 'Whether the customer agreed to ad-platform sharing.' },
  { key: 'consentTrueValues', label: 'Values that mean “agreed”', hint: 'Default: yes, true, y, 1, consented, granted, agreed', list: true },
  { key: 'currency', label: 'Currency', hint: 'Three letters, for example INR' },
  { key: 'eventName', label: 'Event name sent to the platforms', hint: 'Default: Purchase' },
];
