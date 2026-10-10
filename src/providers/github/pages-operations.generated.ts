// GENERATED FILE. DO NOT EDIT.
// Source: github/rest-api-description@d4278c869e367f5d6d4e0f46878119128abba77b
// SHA-256: 9d0534e66064a95f0637d542b463a868fc60a53a8cac37eddc85d72a465b8810
import type { GitHubObservationOperation } from './openapi.ts';

export const PAGES_SETTINGS_OPERATION: GitHubObservationOperation = {
  provider: 'github',
  api_version: '2026-03-10',
  method: 'GET',
  path_template: '/repos/{owner}/{repo}/pages',
  operation_id: 'repos/get-pages',
  parameters: [
    {
      name: 'owner',
      in: 'path',
      required: true,
      schema: {
        type: 'string',
      },
    },
    {
      name: 'repo',
      in: 'path',
      required: true,
      schema: {
        type: 'string',
      },
    },
  ],
  outcomes: [
    {
      status: '200',
      description: 'Response',
      schema: {
        type: 'object',
        properties: {
          source: {
            type: 'object',
            properties: {
              branch: {
                type: 'string',
              },
              path: {
                type: 'string',
              },
            },
          },
          html_url: {
            type: 'string',
            description: 'The web address the Page can be accessed from.',
            format: 'uri',
            example: 'https://example.com',
          },
          build_type: {
            type: 'string',
            description: 'The process in which the Page will be built.',
            example: 'legacy',
            nullable: true,
            enum: ['legacy', 'workflow'],
          },
          cname: {
            description: "The Pages site's custom domain",
            example: 'example.com',
            type: 'string',
            nullable: true,
          },
          public: {
            type: 'boolean',
            description:
              'Whether the GitHub Pages site is publicly visible. If set to `true`, the site is accessible to anyone on the internet. If set to `false`, the site will only be accessible to users who have at least `read` access to the repository that published the site.',
            example: true,
          },
        },
      },
    },
  ],
  github_extensions: {
    githubCloudOnly: false,
    enabledForGitHubApps: true,
    category: 'pages',
    subcategory: 'pages',
  },
};
export const PAGES_BUILD_OPERATION: GitHubObservationOperation = {
  provider: 'github',
  api_version: '2026-03-10',
  method: 'GET',
  path_template: '/repos/{owner}/{repo}/pages/builds/latest',
  operation_id: 'repos/get-latest-pages-build',
  parameters: [
    {
      name: 'owner',
      in: 'path',
      required: true,
      schema: {
        type: 'string',
      },
    },
    {
      name: 'repo',
      in: 'path',
      required: true,
      schema: {
        type: 'string',
      },
    },
  ],
  outcomes: [
    {
      status: '200',
      description: 'Response',
      schema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            format: 'uri',
          },
          commit: {
            type: 'string',
          },
          status: {
            type: 'string',
          },
          error: {
            type: 'object',
            properties: {
              message: {
                type: 'string',
                nullable: true,
              },
            },
          },
        },
      },
    },
  ],
  github_extensions: {
    githubCloudOnly: false,
    enabledForGitHubApps: true,
    category: 'pages',
    subcategory: 'pages',
  },
};
