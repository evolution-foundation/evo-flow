import { RecipientSourceExtractor } from './recipient-source.extractor';

describe('RecipientSourceExtractor', () => {
  const extractor = new RecipientSourceExtractor();

  it('extracts useragent/ip from a SendGrid event array (first event)', () => {
    const payload = [
      { event: 'open', useragent: 'Mozilla/5.0', ip: '8.8.8.8' },
      { event: 'click', useragent: 'other', ip: '1.1.1.1' },
    ];
    expect(extractor.extract('sendgrid', payload)).toEqual({
      userAgent: 'Mozilla/5.0',
      ip: '8.8.8.8',
    });
  });

  it('extracts user_agent/ip from a Mandrill event array', () => {
    const payload = [
      { event: 'open', user_agent: 'Mozilla/5.0', ip: '8.8.8.8' },
    ];
    expect(extractor.extract('mandrill', payload)).toEqual({
      userAgent: 'Mozilla/5.0',
      ip: '8.8.8.8',
    });
  });

  it('extracts from a Resend engagement payload (data.open)', () => {
    const payload = {
      type: 'email.opened',
      data: { open: { userAgent: 'Mozilla/5.0', ipAddress: '8.8.8.8' } },
    };
    expect(extractor.extract('resend', payload)).toEqual({
      userAgent: 'Mozilla/5.0',
      ip: '8.8.8.8',
    });
  });

  it('extracts from an SES SNS-wrapped click event (Message is a JSON string)', () => {
    const payload = {
      Type: 'Notification',
      Message: JSON.stringify({
        eventType: 'Click',
        click: { userAgent: 'Mozilla/5.0', ipAddress: '8.8.8.8' },
      }),
    };
    expect(extractor.extract('ses', payload)).toEqual({
      userAgent: 'Mozilla/5.0',
      ip: '8.8.8.8',
    });
  });

  it('extracts from a SparkPost track_event', () => {
    const payload = [
      {
        msys: {
          track_event: { user_agent: 'Mozilla/5.0', ip_address: '8.8.8.8' },
        },
      },
    ];
    expect(extractor.extract('sparkpost', payload)).toEqual({
      userAgent: 'Mozilla/5.0',
      ip: '8.8.8.8',
    });
  });

  it('returns {} for evolution-api (no recipient UA/IP in body)', () => {
    expect(extractor.extract('evolution-api', { foo: 'bar' })).toEqual({});
  });

  it('returns {} when the payload lacks the expected fields', () => {
    expect(extractor.extract('sendgrid', [{ event: 'delivered' }])).toEqual({});
    expect(extractor.extract('resend', { data: {} })).toEqual({});
    expect(extractor.extract('sparkpost', { msys: {} })).toEqual({});
  });

  it('returns {} for a non-object payload', () => {
    expect(extractor.extract('sendgrid', null)).toEqual({});
    expect(extractor.extract('sendgrid', 'not-json')).toEqual({});
  });
});
