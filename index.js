const urljoin = require('url-join');
const path = require('path');
const mime = require('mime-types');
const axios = require('axios');
const fs = require('fs-extra');
const prompts = require('prompts');
const { info, error, warn, done, logWithSpinner, stopSpinner, chalk } = require('@vue/cli-shared-utils');

function listFiles(folder) {
  const result = [];

  const files = fs.readdirSync(folder);
  files.forEach(file => {
    const fileWithPath = path.join(folder, file);
    const stats = fs.statSync(fileWithPath);
    if (stats.isDirectory()) {
      const subFiles = listFiles(path.join(folder, file));
      subFiles.forEach(subFile => {
          result.push(path.join(file, subFile));
      });
    } else {
      result.push(file);
    }
  });

  return result;
}

function dataItemsBaseUrl(dynappConfig) {
  return urljoin(dynappConfig.baseUrl, 'dynapp-server/rest/groups', dynappConfig.group, 'apps', dynappConfig.app)
}

/* Made in a queue due to dynapp-server locking mechanism */
function uploadDataItems(dynappConfig, prefix, files, distFolder) {
  if (files.length === 0) {
    return Promise.resolve(null);
  }

  const uploadQueue = files.slice(0);
  return new Promise((resolve, reject) => {
    const file = uploadQueue.pop();
    uploadDataItem(dynappConfig, path.join(distFolder, file), prefix + file)
      .then(() => {
        uploadDataItems(dynappConfig, prefix, uploadQueue, distFolder)
        .then(resolve)
        .catch(reject);
      })
      .catch(reject);
  });
}

function uploadDataItem(dynappConfig, file, targetFile) {
  return axios({
    method: 'PUT',
    url: urljoin(dataItemsBaseUrl(dynappConfig), 'data-items', targetFile),
    headers: {
      'Content-Type': mime.lookup(targetFile) || '',
      'X-Category': '2'
    },
    data: fs.createReadStream(file),
    responseType: 'text',
    auth: {
      username: dynappConfig.username,
      password: dynappConfig.password
    }
  });
}

async function clearDataItems(dynappConfig, prefix) {
  const resp = await axios({
    method: 'GET',
    url: urljoin(dataItemsBaseUrl(dynappConfig), 'data-items/'),
    auth: {
      username: dynappConfig.username,
      password: dynappConfig.password
    }
  });
  const existingWebDataItems = Object.keys(resp.data).filter(dataItem => dataItem.startsWith(prefix));
  const operations = existingWebDataItems.map(dataItem => {
    return axios({
      method: 'DELETE',
      url: urljoin(dataItemsBaseUrl(dynappConfig), 'data-items', dataItem),
      auth: {
        username: dynappConfig.username,
        password: dynappConfig.password
      }
    });
  });

  return await Promise.all(operations);
}

function getDynappProxyConfig(dynappConfig, endpoint) {
  var pattern = '^/' + endpoint + '/';

  var baseurl = dynappConfig.baseUrl;

  // Use rungroup and runapp if they exists, otherwise fall back to group and app
  var group = dynappConfig.rungroup;
  if (!group) {
    group = dynappConfig.group;
  }

  var app = dynappConfig.runapp;
  if (!app) {
    app = dynappConfig.app;
  }

  var target = urljoin(dynappConfig.baseUrl, 'dynapp-server/public', group, app, endpoint);

  return {
    localPath: pattern,
    config: {
      target: target,
      ws: false,
      changeOrigin: true,
      pathRewrite: {
        [pattern]: '/'
      }
    }
  };
}

function assembleDynappProxyConfigs(dynappConfig, endpoints) {
  var proxyConfigs = {};
  endpoints.map(endpoint => {
    var {localPath, config} = getDynappProxyConfig(dynappConfig, endpoint);
    proxyConfigs[localPath] = config;
  });
  return proxyConfigs;
}

module.exports = api => {
  var dynappInfoPath = path.join(
    api.getCwd(), 'node_modules', 'vue-cli-plugin-dynapp', 'dynapp-info.json'
  );

  var dynappConfig;
  try {
    dynappConfig = require(api.resolve('dynappconfig.json'));
  } catch (err) {
    try {
      dynappConfig = require(api.resolve('../dynappconfig.json'));
    } catch (err) {
      // We have no server to attach to, so no use to setup dynapp
      info('No dynappconfig.json found, dynapp tooling is not active.');
      // Clear DynApp info file
      fs.writeFileSync(
        dynappInfoPath,
        '{}'
      );
      return;
    }
  }

  // Set up proxies if command is serve
  if (process.argv.indexOf('serve') != -1) {
    var localPackage = require(path.join(api.getCwd(), 'package.json'));
    var proxyConfigs = {};
    var dependencies = {
      ...localPackage.dependencies || {},
      ...localPackage.devDependencies || {}
    };
    if (dependencies) {
      for (var dep in dependencies) {
        var depPackage = require(path.join(api.getCwd(), 'node_modules', dep, 'package.json'));

        if (depPackage.dynappProxies) {
          var depProxyConfigs = assembleDynappProxyConfigs(dynappConfig, depPackage.dynappProxies);

          for (localPath in depProxyConfigs) {
            proxyConfigs[localPath] = depProxyConfigs[localPath];
          }
        }
      }
    }

    if (localPackage.dynappProxies) {
      var selfProxyConfigs = assembleDynappProxyConfigs(dynappConfig, localPackage.dynappProxies);
      for (localPath in selfProxyConfigs) {
        proxyConfigs[localPath] = selfProxyConfigs[localPath];
      }
    }

    if (Object.keys(proxyConfigs).length > 0) {
      var proxyExample = getDynappProxyConfig(dynappConfig, '');
      info('Proxy(s) set up for: ' + proxyExample.config.target);
      for (localPath in proxyConfigs) {
        info('Proxy: ' + localPath.slice(1));
      }
      api.chainWebpack(config => config.devServer.proxy(proxyConfigs));
    }

    // Update DynApp info file
    var dynappInfo = {
      host: '',
      app: '',
      group: ''
    };
    if (dynappConfig) {
      let baseUrl = dynappConfig.baseUrl;
      if (baseUrl) {
        dynappInfo.host = (baseUrl.split('://')[1] || '').split('/')[0];
      }
      dynappInfo.group = dynappConfig.rungroup || dynappConfig.group || '';
      dynappInfo.app = dynappConfig.runapp || dynappConfig.app || '';
    }
    fs.writeFileSync(
      dynappInfoPath,
      JSON.stringify(dynappInfo)
    );
  }

  api.registerCommand('dynapp-publish', {
    description: 'Publish dist folder to the app on dynapp-server. Removes old data-items for webapp.',
    usage: 'vue-cli-service publish [options]',
    options: {
      '--prefix [prefix]': 'Specify prefix to use for data-items (e.g. web/)'
    }
  }, args => {
    if (!args.prefix) {
      error('Prefix is a required argument');
      process.exit(1);
    }
    const prefix = args.prefix.endsWith('/') ? args.prefix : args.prefix + '/';

    // TODO: Read 'dist/' from webpack config
    const distFolder = 'dist/';
    var distFiles;
    try {
      distFiles = listFiles(distFolder);
    } catch (e) {
      error(`Failed to load '${distFolder}'. Have you built? (${e})`);
      process.exit(1);
    }

    // Confirm publish url and prefix
    prompts({
      type: 'confirm',
      initial: true,
      name: 'confirmed',
      message: 'Publish to: ' + dataItemsBaseUrl(dynappConfig) + ' with prefix: ' + prefix + ' ?'
    }).then((result) => {
      if (result.confirmed) {
        // Remove and publish
        logWithSpinner(`Removing existing data-items in ${prefix}`);
        clearDataItems(dynappConfig, prefix).then((operations) => {
          stopSpinner(false);
          info(`Removed ${operations.length} data-items in ${prefix} ${chalk.green('✔')}`);

          logWithSpinner(`Publishing data-items in ${prefix}`);
          uploadDataItems(dynappConfig, prefix, distFiles, distFolder).then(() => {
            stopSpinner(false);
            done(`Published ${distFiles.length} data-items in ${prefix} ${chalk.green('✔')}`);
          }).catch(err => {
            error(`Error publishing data-item: ${err}`);
            process.exit(1);
          });
        }).catch(err => {
          error(`Error removing data-items: ${err}`);
          process.exit(1);
        });
      } else {
        error('Publish cancelled');
        process.exit(1);
      }
    }, () => {
      error('Failed to prompt confirm');
      process.exit(1);
    });
  });
};
