import { getDistribution } from '../distribution';

const appConfig = require('../../../app.config.js');
const appJson = require('../../../app.json');

describe('distribution (Google Play build vs cuang.dev APK)', () => {
  it('is web unless the build says play', () => {
    expect(getDistribution(undefined)).toBe('web');
    expect(getDistribution({})).toBe('web');
    expect(getDistribution({ distribution: 'PLAY' })).toBe('web');
    expect(getDistribution({ distribution: 'play' })).toBe('play');
  });

  it('regression: the Play build strips REQUEST_INSTALL_PACKAGES (Play forbids self-updating), the web build keeps it', () => {
    const prev = process.env.SILO_DISTRIBUTION;
    try {
      process.env.SILO_DISTRIBUTION = 'play';
      const play = appConfig({ config: JSON.parse(JSON.stringify(appJson.expo)) });
      expect(play.extra).toEqual({ ...appJson.expo.extra, distribution: 'play' });
      expect(play.android.blockedPermissions).toContain('android.permission.REQUEST_INSTALL_PACKAGES');
      expect(play.android.blockedPermissions).toEqual(expect.arrayContaining(appJson.expo.android.blockedPermissions));
      expect(play.android.package).toBe('dev.cuang.silo');

      delete process.env.SILO_DISTRIBUTION;
      const web = appConfig({ config: JSON.parse(JSON.stringify(appJson.expo)) });
      expect(web.extra.distribution).toBe('web');
      expect(web.android.blockedPermissions).not.toContain('android.permission.REQUEST_INSTALL_PACKAGES');
    } finally {
      if (prev === undefined) delete process.env.SILO_DISTRIBUTION;
      else process.env.SILO_DISTRIBUTION = prev;
    }
  });
});
