import React, { useCallback, useEffect, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { ViewportActionArrows } from '@ohif/ui-next';
import { useViewportGrid } from '@ohif/ui-next';
import { utils } from '@ohif/extension-cornerstone';

import promptHydrateRT from '../utils/promptHydrateRT';
import _getStatusComponent from './_getStatusComponent';

import createRTToolGroupAndAddTools from '../utils/initRTToolGroup';
import { usePositionPresentationStore } from '@ohif/extension-cornerstone';

const RT_TOOLGROUP_BASE_NAME = 'RTToolGroup';

function OHIFCornerstoneRTViewport(props: withAppTypes) {
  const {
    children,
    displaySets,
    viewportOptions,
    servicesManager,
    extensionManager,
    commandsManager,
  } = props;

  const {
    displaySetService,
    toolGroupService,
    segmentationService,
    uiNotificationService,
    customizationService,
    viewportActionCornersService,
  } = servicesManager.services;

  const viewportId = viewportOptions.viewportId;

  const toolGroupId = `${RT_TOOLGROUP_BASE_NAME}-${viewportId}`;

  // RT viewport will always have a single display set
  if (displaySets.length > 1) {
    throw new Error('RT viewport should only have a single display set');
  }

  const LoadingIndicatorTotalPercent = customizationService.getCustomization(
    'ui.loadingIndicatorTotalPercent'
  );

  const rtDisplaySet = displaySets[0];

  const [viewportGrid, viewportGridService] = useViewportGrid();

  // States
  const selectedSegmentObjectIndex: number = 0;
  const { setPositionPresentation } = usePositionPresentationStore();

  // Hydration means that the RT is opened and segments are loaded into the
  // segmentation panel, and RT is also rendered on any viewport that is in the
  // same frameOfReferenceUID as the referencedSeriesUID of the RT. However,
  // loading basically means RT loading over network and bit unpacking of the
  // RT data.
  const [isHydrated, setIsHydrated] = useState(rtDisplaySet.isHydrated);
  const [rtIsLoading, setRtIsLoading] = useState(!rtDisplaySet.isLoaded);
  const [element, setElement] = useState(null);
  const [processingProgress, setProcessingProgress] = useState({
    percentComplete: null,
    totalSegments: null,
  });

  // refs
  const referencedDisplaySetRef = useRef(null);

  const { viewports, activeViewportId } = viewportGrid;

  const referencedDisplaySetInstanceUID = rtDisplaySet.referencedDisplaySetInstanceUID;
  const referencedDisplaySet = displaySetService.getDisplaySetByUID(
    referencedDisplaySetInstanceUID
  );
  const referencedDisplaySetMetadata = _getReferencedDisplaySetMetadata(referencedDisplaySet);

  referencedDisplaySetRef.current = {
    displaySet: referencedDisplaySet,
    metadata: referencedDisplaySetMetadata,
  };
  /**
   * OnElementEnabled callback which is called after the cornerstoneExtension
   * has enabled the element. Note: we delegate all the image rendering to
   * cornerstoneExtension, so we don't need to do anything here regarding
   * the image rendering, element enabling etc.
   */
  const onElementEnabled = evt => {
    setElement(evt.detail.element);
  };

  const onElementDisabled = () => {
    setElement(null);
  };

  const storePresentationState = useCallback(() => {
    viewportGrid?.viewports.forEach(({ viewportId }) => {
      commandsManager.runCommand('storePresentation', {
        viewportId,
      });
    });
  }, [viewportGrid]);

  const hydrateRTDisplaySet = useCallback(
    ({ rtDisplaySet, viewportId }) => {
      commandsManager.runCommand('hydrateRTSDisplaySet', {
        displaySet: rtDisplaySet,
        viewportId,
      });
    },
    [commandsManager]
  );

  const getCornerstoneViewport = useCallback(() => {
    const { component: Component } = extensionManager.getModuleEntry(
      '@ohif/extension-cornerstone.viewportModule.cornerstone'
    );

    const { displaySet: referencedDisplaySet } = referencedDisplaySetRef.current;

    // Todo: jump to the center of the first segment
    return (
      <Component
        {...props}
        displaySets={[referencedDisplaySet, rtDisplaySet]}
        viewportOptions={{
          viewportType: 'stack',
          toolGroupId: toolGroupId,
          orientation: viewportOptions.orientation,
          viewportId: viewportOptions.viewportId,
          presentationIds: viewportOptions.presentationIds,
        }}
        onElementEnabled={evt => {
          props.onElementEnabled?.(evt);
          onElementEnabled(evt);
        }}
        onElementDisabled={onElementDisabled}
      ></Component>
    );
  }, [viewportId, rtDisplaySet, toolGroupId]);

  const onSegmentChange = useCallback(
    direction => {
      utils.handleSegmentChange({
        direction,
        segDisplaySet: rtDisplaySet,
        viewportId,
        selectedSegmentObjectIndex,
        segmentationService,
      });
    },
    [selectedSegmentObjectIndex]
  );

  useEffect(() => {
    if (rtIsLoading) {
      return;
    }

    promptHydrateRT({
      servicesManager,
      viewportId,
      rtDisplaySet,
      preHydrateCallbacks: [storePresentationState],
      hydrateRTDisplaySet,
    }).then(isHydrated => {
      if (isHydrated) {
        setIsHydrated(true);
      }
    });
  }, [servicesManager, viewportId, rtDisplaySet, rtIsLoading]);

  useEffect(() => {
    // I'm not sure what is this, since in RT we support Overlapping segments
    // via contours
    const { unsubscribe } = segmentationService.subscribe(
      segmentationService.EVENTS.SEGMENTATION_LOADING_COMPLETE,
      evt => {
        if (evt.rtDisplaySet.displaySetInstanceUID === rtDisplaySet.displaySetInstanceUID) {
          setRtIsLoading(false);
        }

        if (rtDisplaySet?.firstSegmentedSliceImageId && viewportOptions?.presentationIds) {
          const { firstSegmentedSliceImageId } = rtDisplaySet;
          const { presentationIds } = viewportOptions;

          setPositionPresentation(presentationIds.positionPresentationId, {
            viewportType: 'stack',
            viewReference: {
              referencedImageId: firstSegmentedSliceImageId,
            },
            viewPresentation: {},
          });
        }

        if (evt.overlappingSegments) {
          uiNotificationService.show({
            title: 'Overlapping Segments',
            message: 'Overlapping segments detected which is not currently supported',
            type: 'warning',
          });
        }
      }
    );

    return () => {
      unsubscribe();
    };
  }, [rtDisplaySet]);

  useEffect(() => {
    const { unsubscribe } = segmentationService.subscribe(
      segmentationService.EVENTS.SEGMENT_LOADING_COMPLETE,
      ({ percentComplete, numSegments }) => {
        setProcessingProgress({
          percentComplete,
          totalSegments: numSegments,
        });
      }
    );

    return () => {
      unsubscribe();
    };
  }, [rtDisplaySet]);

  /**
   Cleanup the SEG viewport when the viewport is destroyed
   */
  useEffect(() => {
    const onDisplaySetsRemovedSubscription = displaySetService.subscribe(
      displaySetService.EVENTS.DISPLAY_SETS_REMOVED,
      ({ displaySetInstanceUIDs }) => {
        const activeViewport = viewports.get(activeViewportId);
        if (displaySetInstanceUIDs.includes(activeViewport.displaySetInstanceUID)) {
          viewportGridService.setDisplaySetsForViewport({
            viewportId: activeViewportId,
            displaySetInstanceUIDs: [],
          });
        }
      }
    );

    return () => {
      onDisplaySetsRemovedSubscription.unsubscribe();
    };
  }, []);

  useEffect(() => {
    let toolGroup = toolGroupService.getToolGroup(toolGroupId);

    if (toolGroup) {
      return;
    }

    toolGroup = createRTToolGroupAndAddTools(toolGroupService, customizationService, toolGroupId);

    return () => {
      // remove the segmentation representations if seg displayset changed
      segmentationService.removeSegmentationRepresentations(viewportId);

      toolGroupService.destroyToolGroup(toolGroupId);
    };
  }, []);

  useEffect(() => {
    setIsHydrated(rtDisplaySet.isHydrated);

    return () => {
      // remove the segmentation representations if seg displayset changed
      segmentationService.removeSegmentationRepresentations(viewportId);
      referencedDisplaySetRef.current = null;
    };
  }, [rtDisplaySet]);

  const onStatusClick = useCallback(async () => {
    // Before hydrating a RT and make it added to all viewports in the grid
    // that share the same frameOfReferenceUID, we need to store the viewport grid
    // presentation state, so that we can restore it after hydrating the RT. This is
    // required if the user has changed the viewport (other viewport than RT viewport)
    // presentation state (w/l and invert) and then opens the RT. If we don't store
    // the presentation state, the viewport will be reset to the default presentation
    storePresentationState();
    const isHydrated = await hydrateRTDisplaySet({
      rtDisplaySet,
      viewportId,
    });

    setIsHydrated(isHydrated);
  }, [hydrateRTDisplaySet, rtDisplaySet, storePresentationState, viewportId]);

  // ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
  let childrenWithProps = null;

  if (
    !referencedDisplaySetRef.current ||
    referencedDisplaySet.displaySetInstanceUID !==
      referencedDisplaySetRef.current.displaySet.displaySetInstanceUID
  ) {
    return null;
  }

  if (children && children.length) {
    childrenWithProps = children.map((child, index) => {
      return (
        child &&
        React.cloneElement(child, {
          viewportId,
          key: index,
        })
      );
    });
  }

  useEffect(() => {
    viewportActionCornersService.addComponents([
      {
        viewportId,
        id: 'viewportStatusComponent',
        component: _getStatusComponent({
          isHydrated,
          onStatusClick,
        }),
        indexPriority: -100,
        location: viewportActionCornersService.LOCATIONS.topRight,
      },
      {
        viewportId,
        id: 'viewportActionArrowsComponent',
        component: (
          <ViewportActionArrows
            key="actionArrows"
            onArrowsClick={onSegmentChange}
            className={
              viewportId === activeViewportId ? 'visible' : 'invisible group-hover/pane:visible'
            }
          ></ViewportActionArrows>
        ),
        indexPriority: 0,
        location: viewportActionCornersService.LOCATIONS.topRight,
      },
    ]);
  }, [
    activeViewportId,
    isHydrated,
    onSegmentChange,
    onStatusClick,
    viewportActionCornersService,
    viewportId,
  ]);

  return (
    <>
      <div className="relative flex h-full w-full flex-row overflow-hidden">
        {rtIsLoading && (
          <LoadingIndicatorTotalPercent
            className="h-full w-full"
            totalNumbers={processingProgress.totalSegments}
            percentComplete={processingProgress.percentComplete}
            loadingText="Loading RTSTRUCT..."
          />
        )}
        {getCornerstoneViewport()}
        {childrenWithProps}
      </div>
    </>
  );
}

OHIFCornerstoneRTViewport.propTypes = {
  displaySets: PropTypes.arrayOf(PropTypes.object),
  viewportId: PropTypes.string.isRequired,
  dataSource: PropTypes.object,
  children: PropTypes.node,
};

function _getReferencedDisplaySetMetadata(referencedDisplaySet) {
  const image0 = referencedDisplaySet.images[0];
  const referencedDisplaySetMetadata = {
    PatientID: image0.PatientID,
    PatientName: image0.PatientName,
    PatientSex: image0.PatientSex,
    PatientAge: image0.PatientAge,
    SliceThickness: image0.SliceThickness,
    StudyDate: image0.StudyDate,
    SeriesDescription: image0.SeriesDescription,
    SeriesInstanceUID: image0.SeriesInstanceUID,
    SeriesNumber: image0.SeriesNumber,
    ManufacturerModelName: image0.ManufacturerModelName,
    SpacingBetweenSlices: image0.SpacingBetweenSlices,
  };

  return referencedDisplaySetMetadata;
}

export default OHIFCornerstoneRTViewport;
