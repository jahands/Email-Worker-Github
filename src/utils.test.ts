import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { parseFromEmailHeader } from './utils'

describe('utils', () => {
  describe('parseFromEmailHeader()', async () => {
    describe('should return email only', async () => {
      const cases: any[][] = [
        ['"Disqus" <notifications@disqus.net>',
          {
            address: 'notifications@disqus.net',
            local: 'notifications',
            name: 'Disqus',
            raw: '"Disqus" <notifications@disqus.net>'
          }],

        ['Tianon Gravi <notifications@github.com>',
          {
            address: 'notifications@github.com',
            local: 'notifications',
            name: 'Tianon Gravi',
            raw: 'Tianon Gravi <notifications@github.com>'
          }],

        ['"github-actions[bot]" <notifications@github.com>',
          {
            address: 'notifications@github.com',
            local: 'notifications',
            name: 'github-actions[bot]',
            raw: '"github-actions[bot]" <notifications@github.com>'
          }],

        ['Mitsuru Oshima (Gerrit) <noreply-gerritcodereview-fsdfsdfsdfdsfdsfsdfsf==@chromium.org>',
          {
            address: 'noreply-gerritcodereview-fsdfsdfsdfdsfdsfsdfsf==@chromium.org',
            local: 'noreply-gerritcodereview-fsdfsdfsdfdsfdsfsdfsf==',
            name: 'Mitsuru Oshima (Gerrit)',
            raw: 'Mitsuru Oshima (Gerrit) <noreply-gerritcodereview-fsdfsdfsdfdsfdsfsdfsf==@chromium.org>'
          }],

        ['Craig Macomber (Microsoft) <notifications@github.com>',
          {
            address: 'notifications@github.com',
            local: 'notifications',
            name: 'Craig Macomber (Microsoft)',
            raw: 'Craig Macomber (Microsoft) <notifications@github.com>'
          }],
      ]
      for (const nextCase of cases) {
        it(nextCase[0], async () => {
          expect(parseFromEmailHeader(nextCase[0])).toStrictEqual(nextCase[1])
        })
      }
    })
  })
})
