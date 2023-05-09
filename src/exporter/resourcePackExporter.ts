import { isValidResourcePackPath, safeFunctionName } from '../minecraft'
import { CustomModelData, IRenderedRig } from '../rendering/modelRenderer'
import { animatedJavaSettings } from '../settings'
import { ExpectedError, LimitClock } from '../util/misc'
import { ProgressBarController } from '../util/progress'
import { translate } from '../util/translation'
import { VirtualFolder } from '../util/virtualFileSystem'

async function fileExists(path: string) {
	return !!(await fs.promises.stat(path).catch(() => false))
}

function showPredicateFileOverwriteConfirmation(path: string) {
	const result = confirm(
		translate('animated_java.popup.confirm_predicate_file_overwrite.body', {
			file: PathModule.parse(path).base,
			path,
		}),
		translate('animated_java.popup.confirm_predicate_file_overwrite.title')
	)
	if (!result) throw new ExpectedError('User cancelled export due to predicate file overwrite.')
}

export async function exportResources(
	ajSettings: typeof animatedJavaSettings,
	projectSettings: NotUndefined<ModelProject['animated_java_settings']>,
	rig: IRenderedRig,
	rigExportFolder: string,
	textureExportFolder: string,
	rigItemModelExportPath: string
) {
	const projectNamespace = projectSettings.project_namespace.value
	const resourcePackPath = PathModule.parse(projectSettings.resource_pack_mcmeta.value).dir
	const resourcePackFolder = new VirtualFolder('internal_resource_pack_folder')
	const assetsPackFolder = resourcePackFolder.newFolder('assets')
	const advancedResourcePackSettingsEnabled =
		projectSettings.enable_advanced_resource_pack_settings.value

	//------------------------------------
	// Minecraft namespace
	//------------------------------------

	const [rigItemNamespace, rigItemName] = projectSettings.rig_item.value.split(':')
	const minecraftFolder = assetsPackFolder.newFolder('minecraft').newFolder('models/item')

	//------------------------------------
	// Rig Item Predicate File
	//------------------------------------

	interface IPredicateItemModel {
		parent: string
		textures: any
		overrides: Array<{
			predicate: { custom_model_data: number }
			model: string
		}>
		animated_java: {
			rigs: Record<string, { used_ids: number[] }>
		}
	}

	const predicateItemFilePath = advancedResourcePackSettingsEnabled
		? rigItemModelExportPath
		: PathModule.join(resourcePackPath, minecraftFolder.path, `${rigItemName}.json`)
	const content: IPredicateItemModel = {
		parent: 'item/generated',
		textures: {
			layer0: `${rigItemNamespace}:item/${rigItemName}`,
		},
		overrides: [],
		animated_java: {
			rigs: {},
		},
	}
	const predicateItemFile = minecraftFolder.newFile(
		`${rigItemName}.json`,
		content,
		// TODO
		(oldContent, newContent) => {
			console.log('Merging predicate file...', oldContent, newContent)
			if (!oldContent.animated_java) {
				showPredicateFileOverwriteConfirmation(predicateItemFilePath)
				oldContent.animated_java = {
					rigs: {
						[projectNamespace]: { used_ids: [] },
					},
				}
			}
			return newContent as unknown
		}
	)
	let successfullyReadPredicateItemFile = false
	if (fs.existsSync(predicateItemFilePath)) {
		const stringContent = await fs.promises.readFile(predicateItemFilePath, 'utf8')
		try {
			const localContent = JSON.parse(stringContent)
			Object.assign(content, localContent)
			successfullyReadPredicateItemFile = true
		} catch (e) {
			console.warn('Failed to read predicate item file as JSON')
			console.warn(e)
		}
	} else successfullyReadPredicateItemFile = true
	if (!successfullyReadPredicateItemFile || !content.animated_java) {
		showPredicateFileOverwriteConfirmation(predicateItemFilePath)
	}
	if (!content.overrides) content.overrides = []
	if (!content.animated_java.rigs) content.animated_java.rigs = {}

	// const content = predicateItemFile.content as IPredicateItemModel
	const usedIds: number[] = [] // IDs that are used by other projects
	const consumedIds: number[] = [] // IDs that are used by this project
	for (const [name, rig] of Object.entries(content.animated_java.rigs)) {
		if (!rig.used_ids) {
			console.warn('Found existing rig in predicate file, but it is missing used_ids.')
			continue
		}
		const localUsedIds = rig.used_ids
		if (name === projectNamespace) {
			// Clean out old overrides
			content.overrides = content.overrides.filter(o => {
				return !localUsedIds.includes(o.predicate.custom_model_data)
			})
			continue
		}
		usedIds.push(...rig.used_ids)
	}

	CustomModelData.usedIds = usedIds
	content.animated_java.rigs[projectNamespace] = {
		used_ids: consumedIds,
	}

	//------------------------------------
	// Project namespace
	//------------------------------------

	const NAMESPACE = projectSettings.project_namespace.value
	const namespaceFolder = assetsPackFolder.newFolder(`${NAMESPACE}_animated_java_rig`)
	const [modelsFolder, texturesFolder] = namespaceFolder.newFolders(
		'models/item',
		'textures/item'
	)

	for (const texture of Object.values(rig.textures)) {
		let image: Buffer | undefined
		let mcmeta: Buffer | undefined
		let optifineEmissive: Buffer | undefined
		if (texture.source?.startsWith('data:')) {
			image = Buffer.from(texture.source.split(',')[1], 'base64')
		} else if (texture.path && fs.existsSync(texture.path)) {
			if (!isValidResourcePackPath(texture.path)) {
				image = await fs.promises.readFile(texture.path)
				if (fs.existsSync(texture.path + '.mcmeta'))
					mcmeta = await fs.promises.readFile(texture.path + '.mcmeta')
				const emissivePath = texture.path.replace('.png', '') + '_e.png'
				if (fs.existsSync(emissivePath))
					optifineEmissive = await fs.promises.readFile(emissivePath)
			}
		} else {
			console.warn(`Texture "${texture.name}" has no source or path`)
		}

		if (image === undefined) continue

		const textureName = safeFunctionName(texture.name)
		texturesFolder.newFile(`${textureName}.png`, image)
		if (mcmeta) texturesFolder.newFile(`${textureName}.png.mcmeta`, mcmeta)
		if (optifineEmissive) texturesFolder.newFile(`${textureName}_e.png`, optifineEmissive)
	}

	for (const bone of Object.values(rig.nodeMap)) {
		if (bone.type !== 'bone') continue
		modelsFolder.newFile(`${bone.name}.json`, bone.model)
		consumedIds.push((bone.customModelData = CustomModelData.get()))
		predicateItemFile.content.overrides.push({
			predicate: {
				custom_model_data: bone.customModelData,
			},
			model: bone.resourceLocation,
		})
	}

	for (const [variantName, variantBoneMap] of Object.entries(rig.variantModels)) {
		if (variantBoneMap.default) continue
		const variantFolder = modelsFolder.newFolder(variantName)
		for (const [uuid, variantBone] of Object.entries(variantBoneMap)) {
			const bone = rig.nodeMap[uuid]
			if (bone.type !== 'bone') continue
			variantFolder.newFile(`${bone.name}.json`, variantBone.model)
			consumedIds.push((variantBone.customModelData = CustomModelData.get()))
			predicateItemFile.content.overrides.push({
				predicate: {
					custom_model_data: variantBone.customModelData,
				},
				model: variantBone.resourceLocation,
			})
		}
	}

	predicateItemFile.content.overrides.sort(
		(a: any, b: any) => a.predicate.custom_model_data - b.predicate.custom_model_data
	)

	interface IAJMeta {
		projects: Record<string, { file_list: string[] }>
	}

	async function processAJMeta(filePaths: string[]) {
		const ajMetaPath = PathModule.join(resourcePackPath, '.ajmeta')
		let content: IAJMeta | undefined

		// FIXME - This is an extremely hacky way to filter out the predicate item file from the file list
		filePaths = filePaths.filter(
			p =>
				p !==
				predicateItemFile.path
					.replace(resourcePackFolder.path + '/', '')
					.replaceAll('/', PathModule.sep)
		)

		if (await fileExists(ajMetaPath)) {
			content = await fs.promises
				.readFile(ajMetaPath, 'utf8')
				.then(JSON.parse)
				.catch(() => {
					throw new Error('Failed to read .ajmeta file as JSON')
				})
			if (!content)
				throw new Error('Failed to read .ajmeta file as JSON. Content is undefined.')

			if (!content.projects) {
				console.warn('Found existing .ajmeta file, but it is missing "projects" key.')
				content.projects = {}
			}

			if (!content.projects[NAMESPACE]) {
				console.warn('Found existing .ajmeta file, but it is missing this project.')
				content.projects[NAMESPACE] = {
					file_list: [],
				}
			} else {
				const progress = new ProgressBarController(
					'Cleaning up old Resource Pack files...',
					content.projects[NAMESPACE].file_list.length
				)
				// Clean out old files from disk
				const clock = new LimitClock(10)
				for (let path of content.projects[NAMESPACE].file_list) {
					await clock.sync().then(b => b && progress.update())
					path = PathModule.join(resourcePackPath, path)
					await fs.promises.unlink(path).catch(() => undefined)
					const dirPath = PathModule.dirname(path)
					const contents = await fs.promises.readdir(dirPath).catch(() => undefined)
					if (contents && contents.length === 0)
						await fs.promises.rmdir(dirPath).catch(() => undefined)
					progress.add(1)
				}
				progress.finish()
			}

			content.projects[NAMESPACE].file_list = filePaths
		}

		if (!content) {
			console.warn('.ajmeta does not exist. Creating new .ajmeta file.')
			content = {
				projects: {
					[NAMESPACE]: {
						file_list: filePaths,
					},
				},
			}
		}

		await fs.promises.writeFile(
			ajMetaPath,
			ajSettings.minify_output.value
				? JSON.stringify(content)
				: JSON.stringify(content, null, 4)
		)
	}

	if (advancedResourcePackSettingsEnabled) {
		const progress = new ProgressBarController(
			'Writing Resource Pack to Disk',
			modelsFolder.childCount + texturesFolder.childCount + 1
		)

		const filePaths = [...modelsFolder.getAllFilePaths(), ...texturesFolder.getAllFilePaths()]

		await processAJMeta(filePaths)

		await fs.promises.mkdir(rigExportFolder, { recursive: true })
		await modelsFolder.writeChildrenToDisk(rigExportFolder, progress)

		await fs.promises.mkdir(textureExportFolder, { recursive: true })
		await texturesFolder.writeChildrenToDisk(textureExportFolder, progress)

		const predicateItemExportFolder = PathModule.parse(rigItemModelExportPath).dir
		await fs.promises.mkdir(predicateItemExportFolder, { recursive: true })
		await predicateItemFile.writeToDisk(predicateItemExportFolder, progress)

		progress.finish()
	} else {
		const progress = new ProgressBarController(
			'Writing Resource Pack to Disk',
			assetsPackFolder.childCount
		)

		const filePaths = resourcePackFolder.getAllFilePaths()

		await processAJMeta(filePaths)

		await assetsPackFolder.writeToDisk(resourcePackPath, progress)

		progress.finish()
	}
}
