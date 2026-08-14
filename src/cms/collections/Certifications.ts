import type { CollectionConfig } from 'payload';

/**
 * The "Most Sought After Certifications as per the Job codes in Canada Jobs
 * market" future module named in the original brief.
 */
export const Certifications: CollectionConfig = {
  slug: 'certifications',
  admin: { useAsTitle: 'name', defaultColumns: ['name', 'issuingBody', 'demand'] },
  access: { read: () => true },
  fields: [
    { name: 'name', type: 'text', required: true },
    { name: 'issuingBody', type: 'text', required: true },
    { name: 'description', type: 'textarea' },
    { name: 'externalUrl', type: 'text' },
    { name: 'logo', type: 'upload', relationTo: 'media' },
    {
      name: 'demand',
      type: 'select',
      label: 'Market demand',
      options: [
        { label: 'High', value: 'high' },
        { label: 'Moderate', value: 'moderate' },
        { label: 'Emerging', value: 'emerging' },
      ],
    },
    {
      name: 'nocCodes',
      type: 'array',
      label: 'Related NOC codes',
      fields: [{ name: 'code', type: 'text', required: true }],
    },
  ],
};
