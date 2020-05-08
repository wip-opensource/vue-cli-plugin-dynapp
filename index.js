const urljoin = require('url-join');
const path = require('path');
const mime = require('mime-types');
const axios = require('axios');
const fs = require('fs-extra')
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
  var pattern = '^/' + endpoint;

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
  var dynappConfig;
  try {
    dynappConfig = require(api.resolve('dynappconfig.json'));
  } catch (err) {
    try {
      dynappConfig = require(api.resolve('../dynappconfig.json'));
    } catch (err) {
      // We have no server to attach to, so no use to setup dynapp
      info('No dynappconfig.json found, dynapp tooling is not active.');
      return;
    }
  }

  // Set up proxies if command is serve
  if (process.argv.indexOf('serve') != -1) {
    var localPackage = require(path.join(api.getCwd(), 'package.json'));
    var proxyConfigs = {};
    if (localPackage.dependencies) {
      for (var dep in localPackage.dependencies) {
        var depPackage = require(path.join(api.getCwd(), 'node_modules', dep, 'package.json'));

        if (depPackage.dynappProxies) {
          var depProxyConfigs = assembleDynappProxyConfigs(dynappConfig, depPackage.dynappProxies);

          for (localPath in depProxyConfigs) {
            if (proxyConfigs[localPath])
              warn(`Proxy for path '${localPath}' is set by multiple dependencies. Only one will be applied`);
            proxyConfigs[localPath] = depProxyConfigs[localPath];
          }
        }
      }
    }

    if (localPackage.dynappProxies) {
      var selfProxyConfigs = assembleDynappProxyConfigs(dynappConfig, localPackage.dynappProxies);
      for (localPath in selfProxyConfigs) {
        if (localPath in proxyConfigs)
          warn(`Proxy for path ${localPath} is set by a dependency, but is overriden by this projects proxy configuration`);
        proxyConfigs[localPath] = selfProxyConfigs[localPath];
      }
    }

    if (Object.keys(proxyConfigs).length > 0) {
      var proxyExample = getDynappProxyConfig(dynappConfig, '');
      info('Proxy(s) set up for: ' + proxyExample.config.target);
      api.chainWebpack(config => config.devServer.proxy(proxyConfigs));
    }
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

    info('Publishing to: ' + dataItemsBaseUrl(dynappConfig) + ' with prefix: ' + prefix);

    logWithSpinner(`Removing existing data-items in ${prefix}`);
    clearDataItems(dynappConfig, prefix).then((operations) => {
      stopSpinner(false);
      info(`Removed ${operations.length} data-items in ${prefix} ${chalk.green('✔')}`);

      // TODO: Read 'dist/' from webpack config
      const distFolder = 'dist/';
      const distFiles = listFiles(distFolder);
      logWithSpinner(`Publishing data-items in ${prefix}`);
      uploadDataItems(dynappConfig, prefix, distFiles, distFolder).then(() => {
        stopSpinner(false);
        done(`Published ${distFiles.length} data-items in ${prefix} ${chalk.green('✔')}`);
      }).catch(error => {
        error(`Error publishing data-item: ${error}`);
      });
    }).catch(error => {
      error(`Error removing data-items: ${error}`);
    });
  });
};
